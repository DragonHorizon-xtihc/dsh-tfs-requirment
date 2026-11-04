/**
 * 凭据擦除（跨宿主半/客户端半共享的**纯函数**，T033 / CHK002）。
 *
 * **为什么放在 shared**：它被两处以上的宿主半模块需要——
 * `host/health.ts`（连通性自检的错误归类）与 `tfs/adapter.ts`（写调用失败的返回原因）——
 * 而 `tfs/` 不应反向依赖 `host/`（分层方向是 host → tfs）。放在 shared 保证只有一份实现：
 * 擦除规则一旦有缺口，缺口会在所有出口同时出现，而不会被某个模块的私有副本掩盖。
 *
 * 本模块为纯字符串处理：无 node 依赖、无 @deepseek-ai 依赖，客户端半也可安全引用。
 *
 * @module dsh-tfs-requirment/shared/redact
 */
/**
 * 擦除可能出现在文本里的凭据片段（T033 / CHK002）。
 *
 * 覆盖四类形态：
 *
 * 1. `Authorization` 头（含 `Basic`/`Bearer`/`Digest`/`NTLM`/`Negotiate` 等 scheme）；
 * 2. 查询串或 kv 形式的 `token`/`pat`/`password`/`api_key`/`secret`/`credential` 等键值对，
 *    键名允许 `_`/`-`/`.` 前缀分段（`TFS_PAT`、`AZURE_DEVOPS_PAT`、`refresh_token`、`x-pat`）；
 * 3. URL 的 userinfo 段（`https://user:secret@host`）；
 * 4. 形如 base64 的裸令牌（长度 ≥ 20），覆盖被塞进任意文本的令牌体。
 *
 * **为何必要**：TFS 的报错经常回显请求 URL（TFS 允许 `?token=` 或 `?pat=` 形式的
 * 查询串鉴权）。若把原始报错直接塞进面板或日志，凭据就泄漏了——这是 SC-008 安全面的一部分。
 *
 * @param text - 原始文本（错误消息、URL 等）。
 * @returns 已擦除凭据的文本。
 */
export declare function scrubCredentials(text: string): string;
//# sourceMappingURL=redact.d.ts.map