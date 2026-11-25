/**
 * 资源选择弹窗：把你「系统里的资源」列出来，供**导入**到当前工作区。
 *
 * ★ 这里是「上传 vs 导入」这条分界线在 UI 上的落点
 *   - 弹窗顶部两个按钮：上传模型 / 上传 VMD  → 外部文件进系统存储
 *   - 下面两张清单：模型 / VMD  → 点「导入」把系统存储里的资源取出来用
 *
 *   清单里的 VMD 分 uploaded（外来）与 generated（系统生成）两类，
 *   但**导入时一视同仁** —— 用户不需要在意它从哪来。
 */

import { useCallback, useEffect, useState } from "react";
import { Box, FolderUp, RefreshCw, Trash2, Upload, X } from "lucide-react";
import {
  deleteModel as deleteModelAsset,
  deleteVmd as deleteVmdAsset,
  listModels,
  listVmd,
  type ModelAsset,
  type VmdAsset,
} from "../../io/assets.ts";
import { fmtBytes } from "../../io/api.ts";
import { cn } from "../cn.ts";

export interface AssetPickerProps {
  open: boolean;
  /** 打开时默认停在哪个 Tab（菜单里「导入模型 / 导入 VMD」分别对应） */
  initialTab?: "models" | "vmd";
  onClose: () => void;
  /** 上传：打开本地文件夹选择器（外部文件 → 系统存储） */
  onUploadModel: () => void;
  /** 上传：打开本地文件选择器 */
  onUploadVmd: () => void;
  /** 导入：系统模型 → 引擎 */
  onImportModel: (id: string) => void;
  /** 导入：系统 VMD → 片段库。`name` 是资源名，用于片段的库条目命名 */
  onImportVmd: (id: string, name: string) => void;
  /**
   * 从系统删掉一份 VMD 之后的通知。
   *
   * ★ 删除是「删硬盘上的存盘文件」：动作库里可能还有条目挂着这个 assetId，
   *   回调让上层把那些条目解除硬盘关联（标记为「未存盘」），
   *   否则会留下悬空 assetId（点存盘会 404）。
   */
  onVmdDeleted?: (id: string) => void;
  /**
   * VMD 列表的用途：
   *   `open`  —— 换掉当前正在编辑的文档（菜单 → 导入 VMD）
   *   `library` —— 往动作库里再加一份（片段库面板的「导入」）
   * 只影响按钮文案与「当前」标记，数据来源相同：都只列系统已上传的 VMD。
   */
  vmdMode?: "open" | "library";
  /** `vmdMode === "open"` 时，当前文档对应的资源 id（用于打「当前」标记） */
  currentVmdAssetId?: string | null;
  /**
   * 场上当前已载入的模型资源 id。
   *
   * ★ 存储可以有多份 PMX，但**场上只能有一个模型**：
   *   这一条用于打「当前」标记，并禁用它的「载入」按钮（重复载入无意义）。
   */
  currentModelAssetId?: string | null;
  busy?: boolean;
}

export function AssetPicker({
  open,
  initialTab = "vmd",
  onClose,
  onUploadModel,
  onUploadVmd,
  onImportModel,
  onImportVmd,
  onVmdDeleted,
  currentModelAssetId = null,
  vmdMode = "open",
  currentVmdAssetId = null,
  busy = false,
}: AssetPickerProps) {
  const [tab, setTab] = useState<"models" | "vmd">(initialTab);
  // 每次打开都按调用方指定的 Tab 重置（菜单能直接落到「模型」或「VMD」）
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  const [models, setModels] = useState<ModelAsset[]>([]);
  const [vmd, setVmd] = useState<VmdAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, v] = await Promise.all([listModels(), listVmd()]);
      setModels(m);
      setVmd(v);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const removeModel = useCallback(async (id: string) => {
    try {
      await deleteModelAsset(id);
      setModels((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const removeVmd = useCallback(
    async (id: string) => {
      try {
        await deleteVmdAsset(id);
        setVmd((prev) => prev.filter((v) => v.id !== id));
        // ★ 通知上层：动作库里挂着这条 assetId 的条目要解除硬盘关联（变「未存盘」）
        onVmdDeleted?.(id);
        // ★ 重新拉一次列表：保证 tab 计数等所有派生显示都刷新
        void refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onVmdDeleted, refresh],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-card border border-line-strong bg-surface shadow-[0_24px_64px_rgb(0_0_0/0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <Box size={13} className="text-accent" />
          <span className="text-[12.5px] font-semibold text-fg">系统资源</span>
          <button
            type="button"
            title="刷新"
            onClick={() => void refresh()}
            className="ml-auto grid size-6 place-items-center rounded text-faint transition-colors hover:bg-white/[0.07] hover:text-fg"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            title="关闭"
            onClick={onClose}
            className="grid size-6 place-items-center rounded text-faint transition-colors hover:bg-white/[0.07] hover:text-danger"
          >
            <X size={13} />
          </button>
        </div>

        {/* 上传区（外部 → 系统存储） */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-raised/40 px-3 py-2">
          <span className="text-[10.5px] text-faint">上传到系统存储：</span>
          <button
            type="button"
            onClick={onUploadModel}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-line-strong bg-raised px-2 py-1 text-[11px] text-dim transition-colors hover:text-fg disabled:opacity-40"
          >
            <FolderUp size={11} />
            上传模型
          </button>
          <button
            type="button"
            onClick={onUploadVmd}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-line-strong bg-raised px-2 py-1 text-[11px] text-dim transition-colors hover:text-fg disabled:opacity-40"
          >
            <Upload size={11} />
            上传 VMD
          </button>
        </div>

        {/* Tab */}
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 pt-1.5">
          {(["vmd", "models"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-t px-3 py-1.5 text-[11.5px] transition-colors",
                tab === key
                  ? "border-b-2 border-accent text-fg"
                  : "border-b-2 border-transparent text-faint hover:text-dim",
              )}
            >
              {key === "vmd" ? `VMD（${vmd.length}）` : `模型（${models.length}）`}
            </button>
          ))}
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && (
            <p className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
              {error}
            </p>
          )}

          {tab === "vmd" && (
            <ul className="space-y-1">
              {vmd.length === 0 && !loading && (
                <li className="px-2 py-6 text-center text-[11.5px] text-faint">
                  系统里还没有 VMD。先点上方「上传 VMD」，或编辑后「保存到系统」。
                </li>
              )}
              {vmd.map((asset) => (
                <li
                  key={asset.id}
                  className="group flex items-center gap-2 rounded border border-line/60 bg-raised/30 px-2.5 py-1.5"
                >
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-px font-mono text-[9.5px]",
                      asset.origin === "generated" ? "bg-accent/15 text-accent" : "bg-white/[0.08] text-dim",
                    )}
                    title={asset.origin === "generated" ? "系统生成" : "用户上传"}
                  >
                    {asset.origin === "generated" ? "生成" : "上传"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={asset.name}>
                    {asset.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
                    {asset.frame_count ?? 0} 帧 · {fmtBytes(asset.size_bytes)}
                  </span>
                  <button
                    type="button"
                    title={vmdMode === "library" ? "加入动作库" : "打开这份动作"}
                    onClick={() => onImportVmd(asset.id, asset.name)}
                    disabled={busy || (vmdMode === "open" && asset.id === currentVmdAssetId)}
                    className="shrink-0 rounded border border-accent/40 bg-accent/12 px-2 py-0.5 text-[10.5px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
                  >
                    {vmdMode === "library" ? "加入库" : asset.id === currentVmdAssetId ? "当前" : "导入"}
                  </button>
                  <button
                    type="button"
                    title="从系统删除"
                    onClick={() => void removeVmd(asset.id)}
                    className="grid size-5 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tab === "models" && (
            <ul className="space-y-1">
              {models.length === 0 && !loading && (
                <li className="px-2 py-6 text-center text-[11.5px] text-faint">
                  系统里还没有模型。点上方「上传模型」加入一个 PMX 文件夹。
                </li>
              )}
              {models.map((asset) => {
                const isCurrent = asset.id === currentModelAssetId;
                return (
                <li
                  key={asset.id}
                  className="group flex items-center gap-2 rounded border border-line/60 bg-raised/30 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={asset.name}>
                    {asset.name}
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 rounded-full bg-ok/15 px-1.5 py-px font-mono text-[9.5px] text-ok">
                      当前
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
                    {asset.file_count} 文件 · {fmtBytes(asset.size_bytes)}
                  </span>
                  <button
                    type="button"
                    title="导入到当前工作区"
                    onClick={() => onImportModel(asset.id)}
                    disabled={busy || isCurrent}
                    className="shrink-0 rounded border border-accent/40 bg-accent/12 px-2 py-0.5 text-[10.5px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
                  >
                    {isCurrent ? "当前" : "导入"}
                  </button>
                  <button
                    type="button"
                    title="从系统删除"
                    onClick={() => void removeModel(asset.id)}
                    className="grid size-5 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
