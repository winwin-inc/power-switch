import { useState } from "react";
import { RotateCcw, AlertTriangle } from "lucide-react";
import { Modal, ModalFooter } from "./components";
import type { InitializationOptions } from "./types";

/** 让用户明确选择初始化范围，至少选择一项才能进入确认。 */
export function InitializationSection({
  busy,
  onRequest,
}: {
  busy: boolean;
  onRequest: (options: InitializationOptions) => void;
}) {
  const [options, setOptions] = useState<InitializationOptions>({
    models: false,
    mcp: false,
  });
  return (
    <section className="settings-section initialization-section">
      <div className="section-title">
        <RotateCcw size={19} />
        <div>
          <h2>配置初始化</h2>
          <p>选择需要清空的内容，至少选择一项。</p>
        </div>
      </div>
      <div className="initialization-options">
        <label className="initialization-option">
          <input
            type="checkbox"
            checked={options.models}
            disabled={busy}
            onChange={(e) =>
              setOptions({ ...options, models: e.target.checked })
            }
          />
          <span>
            <strong>模型库和模型备份</strong>
            <small className="field-hint">
              清空模型与历史备份，退出 New API 登录并清除本机会话和关联记录。
            </small>
          </span>
        </label>
        <label className="initialization-option">
          <input
            type="checkbox"
            checked={options.mcp}
            disabled={busy}
            onChange={(e) => setOptions({ ...options, mcp: e.target.checked })}
          />
          <span>
            <strong>MCP 连接器配置</strong>
            <small className="field-hint">
              删除用户添加的连接器，保留内置连接器并清空其令牌。
            </small>
          </span>
        </label>
      </div>
      <p className="field-hint">
        仅清理本应用数据；已写入 Agent 的配置、外观与路径设置、Skills 保留。
      </p>
      <button
        type="button"
        className="button danger"
        disabled={busy || (!options.models && !options.mcp)}
        onClick={() => onRequest({ ...options })}
      >
        <RotateCcw size={16} />
        配置初始化
      </button>
    </section>
  );
}

/** 二次确认选定范围，显示退出或清理失败的原因并在执行时禁止重复提交。 */
export function InitializationConfirmation({
  options,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  options: InitializationOptions;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="确认配置初始化"
      description="仅清空下面选中的内容，此操作无法撤销。"
      onClose={onClose}
      busy={busy}
    >
      <div className="warning-note">
        <AlertTriangle size={18} />
        <div>
          {options.models && (
            <p>
              模型库和模型备份：清空所有模型、备份及 New API
              登录状态和关联记录。先退出服务端会话，再清除本地数据。
            </p>
          )}
          {options.mcp && (
            <p>MCP 连接器配置：删除自定义连接器，清空内置连接器的令牌。</p>
          )}
        </div>
      </div>
      <p className="field-hint">
        不改动已写入 Agent 的配置，也不撤销服务端模型 API Key。
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <ModalFooter>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || (!options.models && !options.mcp)}
          onClick={onConfirm}
        >
          {busy ? "正在初始化…" : "确认初始化"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
