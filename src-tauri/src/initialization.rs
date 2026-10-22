use crate::{
    adapters::Change,
    files::{self, Snapshot},
    model::AppResult,
    paths::Paths,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(test)]
mod workflow_tests;

/// 串联服务端退出和本地事务，网络失败时完整保留本地数据以便重试。
pub async fn initialize(
    engine: &std::sync::Mutex<crate::engine::Engine>,
    connector: &mut crate::new_api::NewApi,
    options: InitializationOptions,
) -> AppResult<()> {
    let plan = engine
        .lock()
        .map_err(|_| "应用数据锁异常，请重启")?
        .prepare_initialization(options)?;
    if options.models {
        connector
            .logout_for_initialization()
            .await
            .map_err(|error| error.message)?;
    }
    engine
        .lock()
        .map_err(|_| "应用数据锁异常，请重启")?
        .complete_initialization(plan)?;
    if options.models {
        connector.finish_initialization();
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializationOptions {
    pub models: bool,
    pub mcp: bool,
}

impl InitializationOptions {
    /// 后端独立校验范围，拒绝绕过界面提交空初始化请求。
    pub fn validate(self) -> AppResult<()> {
        if !self.models && !self.mcp {
            return Err("请至少选择一项初始化内容".into());
        }
        Ok(())
    }
}

pub struct InitializationPlan {
    pub options: InitializationOptions,
    data_dir: PathBuf,
    changes: Vec<Change>,
    directories: Vec<(PathBuf, Vec<PathBuf>)>,
}

/// 仅枚举应用自有目录中的 JSON 文件，不递归删除目录或跟随链接。
fn json_files(directory: &Path) -> AppResult<Vec<PathBuf>> {
    files::private_dir(directory)?;
    let mut names = vec![];
    for entry in fs::read_dir(directory).map_err(|_| "无法读取初始化目录")? {
        let path = entry.map_err(|_| "无法检查初始化文件")?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            Snapshot::read(&path)?;
            names.push(path);
        }
    }
    names.sort();
    Ok(names)
}

impl InitializationPlan {
    /// 在任何服务端退出和本地删除之前，读取并校验选中范围的全部文件。
    pub fn prepare(
        paths: &Paths,
        options: InitializationOptions,
        models: Option<Vec<u8>>,
    ) -> AppResult<Self> {
        options.validate()?;
        files::private_dir(&paths.data)?;
        let mut changes = vec![];
        let mut directories = vec![];
        if options.models {
            changes.push(Change {
                before: Snapshot::read(&paths.data.join("models.json"))?,
                after: models,
            });
            changes.push(Change {
                before: Snapshot::read(&paths.data.join("new-api.json"))?,
                after: None,
            });
            files::private_dir(&paths.data.join("new-api"))?;
            for directory in [
                paths.data.join("backups"),
                paths.data.join("new-api/sessions"),
            ] {
                let names = json_files(&directory)?;
                for path in &names {
                    changes.push(Change {
                        before: Snapshot::read(path)?,
                        after: None,
                    });
                }
                directories.push((directory, names));
            }
        }
        if options.mcp {
            changes.push(Change {
                before: Snapshot::read(&paths.data.join("mcp-connectors.json"))?,
                after: None,
            });
        }
        Ok(Self {
            options,
            data_dir: paths.data.clone(),
            changes,
            directories,
        })
    }

    /// 原子写入各文件并在失败时恢复原始内容，不创建含已清理凭据的新备份。
    pub fn commit(self) -> AppResult<()> {
        self.commit_with(files::write_optional)
    }

    /// 提交前重验文件集合与指纹，注入写入器可测试中途失败后的回滚。
    fn commit_with(
        self,
        mut writer: impl FnMut(&Path, Option<&[u8]>) -> AppResult<()>,
    ) -> AppResult<()> {
        files::private_dir(&self.data_dir)?;
        if self.options.models {
            files::private_dir(&self.data_dir.join("new-api"))?;
        }
        for (directory, names) in &self.directories {
            if json_files(directory)? != *names {
                return Err("初始化期间数据已变化，请重新确认".into());
            }
        }
        for change in &self.changes {
            if !change.before.unchanged()? {
                return Err("初始化期间配置已变化，请重新确认".into());
            }
        }
        let mut attempted = 0;
        let outcome: AppResult<()> = (|| {
            for (index, change) in self.changes.iter().enumerate() {
                if !change.before.unchanged()? {
                    return Err("初始化期间配置已变化，请重新确认".into());
                }
                attempted = index + 1;
                writer(&change.before.path, change.after.as_deref())?;
                if Snapshot::read(&change.before.path)?.fingerprint()
                    != files::fingerprint(change.after.as_deref())
                {
                    return Err("初始化写入校验失败".into());
                }
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            let mut restored = true;
            for change in self.changes[..attempted].iter().rev() {
                match Snapshot::read(&change.before.path) {
                    Ok(current) if current.fingerprint() == change.before.fingerprint() => {}
                    Ok(current)
                        if current.fingerprint() == files::fingerprint(change.after.as_deref()) =>
                    {
                        restored &= files::write_optional(
                            &change.before.path,
                            change.before.bytes.as_deref(),
                        )
                        .is_ok();
                    }
                    _ => restored = false,
                }
            }
            return Err(if restored {
                format!("{error}；本地数据已恢复，请重试")
            } else {
                "初始化失败，部分本地数据恢复失败，请检查数据目录".into()
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 第二个文件写入失败时恢复第一个文件，不留下新的凭据备份。
    #[test]
    fn write_failure_restores_every_attempted_file() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths {
            home: temp.path().join("home"),
            data: temp.path().join("data"),
            workbuddy_env: None,
            codex_env: None,
        };
        files::private_dir(&paths.data).unwrap();
        files::atomic_write(&paths.data.join("models.json"), b"original models").unwrap();
        files::atomic_write(&paths.data.join("new-api.json"), b"original journal").unwrap();
        let plan = InitializationPlan::prepare(
            &paths,
            InitializationOptions {
                models: true,
                mcp: true,
            },
            Some(b"cleared models".to_vec()),
        )
        .unwrap();
        let mut writes = 0;
        assert!(plan
            .commit_with(|path, bytes| {
                writes += 1;
                if writes == 2 {
                    return Err("injected write failure".into());
                }
                files::write_optional(path, bytes)
            })
            .unwrap_err()
            .contains("本地数据已恢复"));
        assert_eq!(
            fs::read(paths.data.join("models.json")).unwrap(),
            b"original models"
        );
        assert_eq!(
            fs::read(paths.data.join("new-api.json")).unwrap(),
            b"original journal"
        );
        assert_eq!(fs::read_dir(paths.data.join("backups")).unwrap().count(), 0);
    }
}
