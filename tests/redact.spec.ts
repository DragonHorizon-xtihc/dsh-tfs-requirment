import { describe, expect, it } from 'vitest'

import { scrubCredentials } from '../src/shared/redact.js'

/**
 * 凭据擦除的回归面（CHK002 / SC-008）。
 *
 * 每条用例都给出**具体的泄漏片段**而不是「不等于输入」，这样规则被削弱时能定位到是哪一类形态漏了。
 */
describe('scrubCredentials', () => {
  it('Authorization 头吃掉令牌体、保留 scheme', () => {
    // 旧实现只吃掉 scheme 单词（Bearer/Basic），令牌原样留在文本里。
    expect(scrubCredentials('Authorization: Bearer s3cr3t')).toBe('Authorization: Bearer [REDACTED]')
    expect(scrubCredentials('Authorization: Basic dXNlcjpwYXNz failed')).toBe(
      'Authorization: Basic [REDACTED] failed',
    )
    expect(scrubCredentials('authorization=Negotiate abc123')).toBe('authorization=Negotiate [REDACTED]')
    // 无 scheme 的裸头也要整段吃掉。
    expect(scrubCredentials('Authorization: dXNlcjpwYXNz')).toBe('Authorization: [REDACTED]')
  })

  it('带前缀分段的凭据键名被擦除（AZURE_DEVOPS_PAT / TFS_PAT / refresh_token / x-pat）', () => {
    // 旧实现用 \b 起始，而 `_` 是单词字符，`\b` 在 `_` 之后永不成立，这些键全部原样通过。
    expect(scrubCredentials('AZURE_DEVOPS_PAT=supersecretvalue123')).toBe('AZURE_DEVOPS_PAT=[REDACTED]')
    expect(scrubCredentials('TFS_PAT=xpe2abcdef')).toBe('TFS_PAT=[REDACTED]')
    expect(scrubCredentials('refresh_token=eyJhbGciOiJIUzI1NiJ9')).toBe('refresh_token=[REDACTED]')
    expect(scrubCredentials('x-pat: qwertyuiop')).toBe('x-pat: [REDACTED]')
    expect(scrubCredentials('api_key = "k-123"')).toBe('api_key = [REDACTED]')
    expect(scrubCredentials("client_secret: 's3cr3t value'")).toBe('client_secret: [REDACTED]')
  })

  it('URL userinfo 的口令段被擦除、主机与端口不被误伤', () => {
    expect(scrubCredentials('GET https://user:sup3rs3cr3t@tfs.example.com/x')).toBe(
      'GET https://user:[REDACTED]@tfs.example.com/x',
    )
    // 无 userinfo 的 host:port 不能被当成凭据。
    expect(scrubCredentials('GET https://tfs.example.com:8080/tfs')).toBe(
      'GET https://tfs.example.com:8080/tfs',
    )
  })

  it('裸 base64 / 长十六进制令牌被擦除', () => {
    expect(scrubCredentials('token body QWxhZGRpbjpvcGVuIHNlc2FtZQ== here')).not.toContain(
      'QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    )
    expect(scrubCredentials('sha 0123456789abcdef0123456789abcdef done')).not.toContain(
      '0123456789abcdef0123456789abcdef',
    )
  })

  it('含 pat 但不是凭据键的单词不被误伤', () => {
    expect(scrubCredentials('captain=jack')).toBe('captain=jack')
    expect(scrubCredentials('工作项 1997179 已领取')).toBe('工作项 1997179 已领取')
    // Authorization 头里的 scheme 名不该被 kv 规则改写掉（保持可读）。
    expect(scrubCredentials('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic [REDACTED]')
  })

  it('对不含凭据的文本是恒等变换', () => {
    const text = 'TFS REST 调用失败（profile=默认）：404 Not Found'
    expect(scrubCredentials(text)).toBe(text)
  })
})