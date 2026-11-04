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

/** 配对替换时复用的「已被擦除」占位符。 */
const REDACTED = '[REDACTED]'

/**
 * 键名后缀：出现在值之前的凭据类字段名（大小写不敏感）。
 *
 * **不含裸 `pat`**：`captain` 之类含 `pat` 的普通单词会误伤，因此只有当 `pat` 前面是
 * 键名分隔符（`_` `-` `.`）或位于键名开头时才认作凭据字段（见 {@link scrubCredentials} 的前缀分组）。
 */
const CREDENTIAL_KEY = '(?:access[_-]?token|auth[_-]?token|refresh[_-]?token|token|pat|password|passwd|pwd|apikey|api[_-]?key|secret|credential)'

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
export function scrubCredentials(text: string): string {
  return (
    text
      // 1) Authorization 头：scheme 之后**整段**都是凭据，必须连令牌一起吃掉，只保留 scheme。
      .replace(
        /(authorization\s*[:=]\s*)((?:basic|bearer|digest|ntlm|negotiate|oauth)\s+)?\S+/gi,
        (_all, head: string, scheme: string | undefined) =>
          `${head}${scheme ? `${scheme.trim()} ` : ''}${REDACTED}`,
      )
      // 2) kv 形式：键名可带 `_`/`-`/`.` 前缀分段（`AZURE_DEVOPS_PAT`、`refresh_token`、`x-pat`），
      //    但前缀必须以分隔符结尾，避免 `captain=` 这类含 `pat` 的普通单词被误伤。
      //    分隔符本身用捕获组保留，因为它不属于键名。
      .replace(
        new RegExp(
          `(^|[^A-Za-z0-9])((?:[A-Za-z0-9]+[_.-])*${CREDENTIAL_KEY}s?)(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s&,;]+)`,
          'gi',
        ),
        (_all, boundary: string, key: string, sep: string) => `${boundary}${key}${sep}${REDACTED}`,
      )
      // 3) URL userinfo：`scheme://user:secret@host` 中的 password 段。
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)([^/\s:@]+)(@)/gi, `$1${REDACTED}$3`)
      // 4) 形如 base64 的裸令牌（长度 ≥ 20）。
      //    十六进制串是它的子集（`[0-9a-f]` ⊂ `[A-Za-z0-9+/]`），故不再单列规则：
      //    任何 ≥32 位十六进制串都先被本规则吃掉，多列一条只会是永不触发的死代码。
      .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, REDACTED)
  )
}