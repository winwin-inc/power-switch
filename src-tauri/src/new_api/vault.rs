use super::{Error, Result};
use crate::files::{self, Snapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

/// Store one instance's serialized login session behind the connector's existing interface.
pub trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, secret: &str) -> Result<()>;
    fn remove(&self, account: &str) -> Result<()>;
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionFile {
    version: u32,
    account: String,
    session: serde_json::Value,
}

pub struct FileVault {
    root: PathBuf,
}

impl FileVault {
    /// Keep plaintext sessions in the app-owned private directory on every platform.
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            root: data_dir.join("new-api").join("sessions"),
        }
    }

    /// Name each session by the SHA-256 of its canonical instance URL, never URL text.
    fn path(&self, account: &str) -> PathBuf {
        let digest = Sha256::digest(account.as_bytes());
        self.root.join(format!("{digest:x}.json"))
    }

    /// Check all app-owned directory components before accessing a credential file.
    fn check_root(&self) -> Result<()> {
        let parent = self
            .root
            .parent()
            .ok_or_else(|| Error::new("storage", "会话目录无效"))?;
        let data = parent
            .parent()
            .ok_or_else(|| Error::new("storage", "数据目录无效"))?;
        for path in [data, parent, self.root.as_path()] {
            files::private_dir(path)
                .map_err(|_| Error::new("storage", "无法保护 New API 会话目录"))?;
        }
        Ok(())
    }
}

impl Vault for FileVault {
    /// Refuse damaged or mismatched records instead of silently using a different login.
    fn get(&self, account: &str) -> Result<Option<String>> {
        self.check_root()?;
        let snapshot = Snapshot::read(&self.path(account))
            .map_err(|_| Error::new("storage", "无法安全读取 New API 登录会话"))?;
        let Some(bytes) = snapshot.bytes else {
            return Ok(None);
        };
        let record: SessionFile = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new("storage", "New API 登录会话文件已损坏"))?;
        if record.version != 1 || record.account != account {
            return Err(Error::new(
                "storage",
                "New API 登录会话格式或实例地址不匹配",
            ));
        }
        serde_json::to_string(&record.session)
            .map(Some)
            .map_err(|_| Error::new("storage", "无法读取 New API 登录会话"))
    }

    /// Atomically persist the existing serialized session as plaintext JSON.
    fn set(&self, account: &str, secret: &str) -> Result<()> {
        self.check_root()?;
        let session = serde_json::from_str(secret)
            .map_err(|_| Error::new("storage", "New API 登录会话格式无效"))?;
        let bytes = serde_json::to_vec_pretty(&SessionFile {
            version: 1,
            account: account.into(),
            session,
        })
        .map_err(|_| Error::new("storage", "无法序列化 New API 登录会话"))?;
        files::atomic_write(&self.path(account), &bytes)
            .map_err(|_| Error::new("storage", "无法保存 New API 登录会话"))
    }

    /// Remove only a verified regular session file for the requested instance.
    fn remove(&self, account: &str) -> Result<()> {
        self.check_root()?;
        let path = self.path(account);
        if Snapshot::read(&path)
            .map_err(|_| Error::new("storage", "无法安全检查 New API 登录会话"))?
            .bytes
            .is_none()
        {
            return Ok(());
        }
        fs::remove_file(path).map_err(|_| Error::new("storage", "无法删除 New API 登录会话"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Persist, reload and remove one plaintext session without affecting another instance.
    #[test]
    fn file_sessions_round_trip_and_isolate_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let vault = FileVault::new(dir.path().join(".power-switch"));
        let account = "https://new-api.example.com";
        vault
            .set(account, r#"{"cookie":"private-cookie"}"#)
            .unwrap();
        let reloaded = FileVault::new(dir.path().join(".power-switch"));
        assert_eq!(
            reloaded.get(account).unwrap().as_deref(),
            Some(r#"{"cookie":"private-cookie"}"#)
        );
        assert_eq!(reloaded.get("https://other.example.com").unwrap(), None);
        let raw = fs::read_to_string(reloaded.path(account)).unwrap();
        assert!(raw.contains("private-cookie"));
        assert!(raw.contains("\"version\": 1"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(reloaded.path(account))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        reloaded.remove(account).unwrap();
        assert_eq!(reloaded.get(account).unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&reloaded.root).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    /// Fail closed for malformed records, mismatched accounts and symlinked session files.
    #[test]
    fn damaged_or_redirected_session_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let vault = FileVault::new(dir.path().join(".power-switch"));
        let account = "https://new-api.example.com";
        vault.set(account, r#"{"cookie":"secret"}"#).unwrap();
        let path = vault.path(account);
        fs::write(&path, "broken-json").unwrap();
        assert_eq!(vault.get(account).unwrap_err().code, "storage");
        fs::write(&path, r#"{"version":1,"account":"wrong","session":{}}"#).unwrap();
        assert_eq!(vault.get(account).unwrap_err().code, "storage");
        #[cfg(unix)]
        {
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(dir.path().join("outside"), &path).unwrap();
            assert_eq!(vault.get(account).unwrap_err().code, "storage");
            assert_eq!(vault.set(account, "{}").unwrap_err().code, "storage");
            assert_eq!(vault.remove(account).unwrap_err().code, "storage");
        }
    }
}
