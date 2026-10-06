# Contract: UI 槽位挂载（FR-021 / FR-028）

> 看板面板挂 `conversation.panel` 常驻侧栏；客户端半经 `dsh.client-ui-slots` 注册。

## 宿主 API（已核实）
- 槽位目录：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:81`
- 客户端须 `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'` 才有 `ctx.slots`
- 注册：`ctx.slots.inject(key, () => ctx.slots.register({ name, id, order, label }, Component))`
- list 槽按 `priority → order` 升序排（order 越小越靠左）
- 槽位 entry 标准 props 仅 `useConversation` / `useInput` / `inputActions`，**不含 sessionId**；
  会话 id 取 `ctx.sessions.list.getSnapshot().current`

## 本插件挂载点
- `conversation.panel`：RequirementPool / TaskCenter / ExecutionPanel / RoleSettings / McpManager 的常驻容器（US3 T040）
- 每需求独立对话界面（FR-030）：发起执行时创建/绑定 DSH session，用户进入查看执行过程

## 契约要点
- 必须 `inject: ['slots']`（客户端半）并经 `ctx.slots.inject` 注册
- 与 DSH 现有形态一致：React 18 + CSS Modules，不引入独立路由
- 降级：slots 服务不可用时静默跳过面板注册，不阻塞宿主加载（装配纪律）
