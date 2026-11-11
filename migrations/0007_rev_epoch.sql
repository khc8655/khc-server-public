-- D-2 / R-2（T2.2）：节点 rev epoch（纪元）。
-- 节点记录带 rev_epoch：创建时生成（应用层 newEpoch()），节点重建/恢复时换新值
-- （重建=新节点行=新 epoch；D1 恢复走"删节点→重建→导入" SOP，同样新建节点行）。
-- Agent 持久化收到的 epoch 并在 /state 与 apply 响应回传；apply 请求带节点当前
-- epoch，Agent 发现不一致即判定"旧纪元"，清除全部应用的 appliedRev 基线，
-- 让控制面重新下发的低 rev 配置不再 409（rev 分叉导致 peer 失联/状态对不上的根因）。
-- 兼容现役 Agent 0.1.12：请求多出的 epoch 字段被旧 Agent 忽略；旧 Agent 不回传
-- epoch 时按"待升级"处理（Worker 不做旧纪元判定），升级后首次 apply 直接采纳。
ALTER TABLE nodes ADD COLUMN rev_epoch TEXT NOT NULL DEFAULT '';
-- 现网存量节点一次性回填随机 epoch（每行独立随机；randomblob 在 UPDATE 中逐行求值）。
-- ALTER ADD COLUMN 不允许表达式默认值，因此先 DEFAULT '' 再回填。
UPDATE nodes SET rev_epoch = lower(hex(randomblob(16)));
