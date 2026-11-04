window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-tfs-requirment",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/components/MultiSelect.tsx
		/**
		* 按 `value` 去重（问题 7）。
		*
		* ## 为什么必须在**组件内部**再兜一道
		*
		* 调用方（`RoleSettings` 的默认模型下拉）用 `m.id` 当 value，而模型的 `id` **只在单个
		* provider 内唯一**：同一 `id` 被 K 个 provider 暴露时，`options` 里就有 K 个同 value 项。
		* 组件此前直接拿 `options.filter(o => set.has(o.value))` 生成已选项
		* （见下方 `selected`），于是：
		*   - 已选区渲染出 K 个**同 key 同文案**的 chip（React duplicate key，点 × 命中的可能是
		*     另一份 fiber ⇒ 用户看到"点了没反应 / 删不掉"）；
		*   - 下拉面板渲染出 K 个同名行，勾一次 K 行同时变蓝（用户看到"出现六次 / 三次"）。
		*
		* 修复只需一处：**在进组件时按 value 折叠**。折叠时把重复项的 `hint` 用 `、` 合并，
		* 保证"这个 id 属于哪几个 provider"这条信息不丢（`RoleSettings` 只传一个 providerName 时
		* 也能看到并集）。
		*
		* 本函数是**纯函数并导出**，因为客户端半没有 React 测试库（项目既有纪律）——
		* 只有纯函数能被 vitest 直接覆盖，DOM 行为再由 E2E 兜。
		*
		* @param options - 原始选项（可能含重复 value）。
		* @returns 去重后的选项（保持首次出现顺序与首个 label）。
		*/
		function dedupeOptions(options) {
			const seen = /* @__PURE__ */ new Map();
			const hints = /* @__PURE__ */ new Map();
			for (const o of options) {
				if (typeof o?.value !== "string" || o.value.length === 0) continue;
				if (!seen.has(o.value)) {
					seen.set(o.value, {
						value: o.value,
						label: o.label,
						...o.hint ? { hint: o.hint } : {}
					});
					hints.set(o.value, o.hint ? [o.hint] : []);
					continue;
				}
				const list = hints.get(o.value);
				if (o.hint && list && !list.includes(o.hint)) list.push(o.hint);
			}
			const out = [];
			for (const [value, base] of seen) {
				const list = hints.get(value) ?? [];
				out.push(list.length > 0 ? {
					...base,
					hint: list.join("、")
				} : base);
			}
			return out;
		}
		const boxStyle = {
			border: "1px solid #d1d5db",
			borderRadius: 6,
			background: "#fff",
			padding: "4px 6px",
			minHeight: 32,
			display: "flex",
			flexWrap: "wrap",
			gap: 4,
			alignItems: "center",
			cursor: "pointer",
			fontSize: 13
		};
		const chipStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
			background: "#eef2ff",
			color: "#3730a3",
			borderRadius: 12,
			padding: "2px 8px",
			fontSize: 12
		};
		const panelStyle = {
			position: "absolute",
			zIndex: 30,
			marginTop: 4,
			minWidth: 260,
			maxWidth: "100%",
			background: "#fff",
			border: "1px solid #d1d5db",
			borderRadius: 8,
			boxShadow: "0 10px 24px rgba(15,23,42,0.14)",
			padding: 8
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "4px 6px",
			borderRadius: 4,
			fontSize: 13,
			cursor: "pointer"
		};
		/**
		* 可搜索多选下拉。
		*
		* @param props.options - 全部可选项（由宿主真实枚举下发，本组件不做任何硬编码兜底）。
		* @param props.value - 当前选中的值列表。
		* @param props.onChange - 变更回调（传回新的值列表，顺序保持 options 顺序，便于稳定 diff）。
		* @param props.placeholder - 未选中时的占位文案。
		* @param props.searchPlaceholder - 搜索框占位文案。
		* @param props.disabled - 禁用（数据加载中 / 宿主未接线时用）。
		* @param props.id - 关联 `<label htmlFor>` 用。
		* @param props.max - 最多可选数量；`1` 时退化为**可搜索单选**（选新值直接替换旧值）。
		*   角色管理的"默认模型"就是单选场景，但模型有几十个且带 provider 前缀，
		*   普通 `<select>` 找不到目标，因此复用本组件而不是再造一个单选框。
		*/
		function MultiSelect(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const [q, setQ] = (0, react.useState)("");
			const rootRef = (0, react.useRef)(null);
			const searchRef = (0, react.useRef)(null);
			/**
			* 去重后的选项（问题 7）：组件内**所有**下游计算只看这一份。
			* 只要它唯一，chip key、下拉行 key、勾选状态就不可能再重复。
			*/
			const options = (0, react.useMemo)(() => dedupeOptions(props.options), [props.options]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDown = (e) => {
					const el = rootRef.current;
					if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (open) searchRef.current?.focus();
			}, [open]);
			/** 归一化：按 options 顺序去重，保证"同一集合不同选择顺序"产出同一结果（便于 diff/幂等）。 */
			const selected = (0, react.useMemo)(() => {
				const set = new Set(props.value);
				return options.filter((o) => set.has(o.value)).map((o) => o.value);
			}, [options, props.value]);
			/** 未在 options 里的已选值仍要保留（历史数据 / 宿主枚举降级时不该被静默丢弃）。 */
			const orphan = (0, react.useMemo)(() => {
				const known = new Set(options.map((o) => o.value));
				return [...new Set(props.value)].filter((v) => !known.has(v));
			}, [options, props.value]);
			const filtered = (0, react.useMemo)(() => {
				const kw = q.trim().toLowerCase();
				if (!kw) return options;
				return options.filter((o) => [
					o.value,
					o.label,
					o.hint ?? ""
				].some((s) => s.toLowerCase().includes(kw)));
			}, [options, q]);
			const labelOf = (v) => {
				const hit = options.find((o) => o.value === v);
				return hit ? hit.label : v;
			};
			const toggle = (v) => {
				if (props.max === 1) {
					props.onChange(selected.includes(v) ? [] : [v]);
					return;
				}
				const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
				props.onChange([...next, ...orphan.filter((o) => !next.includes(o))]);
			};
			const remove = (v) => {
				props.onChange([...selected.filter((x) => x !== v), ...orphan.filter((o) => o !== v)]);
			};
			const allFilteredSelected = filtered.length > 0 && filtered.every((o) => selected.includes(o.value));
			const toggleAllFiltered = () => {
				if (allFilteredSelected) {
					const drop = new Set(filtered.map((o) => o.value));
					props.onChange([...selected.filter((v) => !drop.has(v)), ...orphan]);
				} else props.onChange([.../* @__PURE__ */ new Set([...selected, ...filtered.map((o) => o.value)]), ...orphan.filter((o) => !selected.includes(o))]);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: { position: "relative" },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					id: props.id,
					role: "button",
					tabIndex: props.disabled ? -1 : 0,
					"aria-expanded": open,
					"aria-haspopup": "listbox",
					style: {
						...boxStyle,
						opacity: props.disabled ? .6 : 1,
						cursor: props.disabled ? "not-allowed" : "pointer"
					},
					onClick: () => !props.disabled && setOpen((o) => !o),
					onKeyDown: (e) => {
						if (props.disabled) return;
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							setOpen((o) => !o);
						}
					},
					children: [
						selected.length === 0 && orphan.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { color: "#9ca3af" },
							children: props.placeholder ?? "请选择…"
						}),
						[...selected, ...orphan].map((v) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: chipStyle,
							children: [labelOf(v), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": `移除 ${labelOf(v)}`,
								onClick: (e) => {
									e.stopPropagation();
									remove(v);
								},
								style: {
									border: "none",
									background: "transparent",
									cursor: "pointer",
									color: "#3730a3",
									padding: 0
								},
								children: "×"
							})]
						}, v)),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								marginLeft: "auto",
								color: "#9ca3af",
								fontSize: 11
							},
							children: open ? "▲" : "▼"
						})
					]
				}), open && !props.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: panelStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							ref: searchRef,
							type: "search",
							style: {
								width: "100%",
								boxSizing: "border-box",
								padding: "5px 8px",
								border: "1px solid #d1d5db",
								borderRadius: 6,
								fontSize: 13,
								marginBottom: 6
							},
							placeholder: props.searchPlaceholder ?? "输入关键字筛选…",
							value: q,
							onChange: (e) => setQ(e.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								marginBottom: 4
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: [
									filtered.length,
									" / ",
									options.length,
									" 项"
								]
							}), props.max !== 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: toggleAllFiltered,
								style: {
									border: "none",
									background: "transparent",
									color: "#2563eb",
									cursor: "pointer",
									fontSize: 12,
									padding: 0
								},
								children: allFilteredSelected ? "清空当前筛选结果" : "全选当前筛选结果"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "listbox",
							"aria-multiselectable": true,
							style: {
								maxHeight: 240,
								overflowY: "auto"
							},
							children: [filtered.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#9ca3af",
									padding: "6px 6px"
								},
								children: options.length === 0 ? "暂无可选项（宿主未返回数据）" : "无匹配项"
							}), filtered.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								role: "option",
								"aria-selected": selected.includes(o.value),
								style: {
									...rowStyle,
									background: selected.includes(o.value) ? "#eff6ff" : "transparent"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: selected.includes(o.value),
									onChange: () => toggle(o.value)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										flex: 1,
										minWidth: 0
									},
									children: [o.label, o.hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											color: "#9ca3af",
											fontSize: 11,
											marginLeft: 6
										},
										children: o.hint
									})]
								})]
							}, o.value))]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/shared/text.ts
		/**
		* 按字符（码点）切前 `max` 个字，**不劈开代理对**。
		*
		* `String.prototype.slice` 按 UTF-16 码元计数，切点落在代理对中间时会留下一个
		* 孤立的高代理（U+D800–U+DBFF）：它在界面上渲染成 `�`，写进 `board.json` 后
		* 就固化成 U+FFFD。星标、emoji、中文扩展字都在代理对上，所以这不是理论问题。
		*
		* @param text - 原文。
		* @param max - 保留的码元上限（<=0 表示不保留）。
		* @returns 最多 `max` 个码元、且不以半个代理对结尾的前缀。
		*/
		function sliceTextByCodePoint(text, max) {
			if (max <= 0) return "";
			if (text.length <= max) return text;
			const cut = text.charCodeAt(max - 1);
			return cut >= 55296 && cut <= 56319 ? text.slice(0, max - 1) : text.slice(0, max);
		}
		//#endregion
		//#region src/shared/pool.ts
		/**
		* 需求去重键 `id@collection`（S-01）。
		*
		* 与宿主半 `requirementDedupKey`（`src/tfs/types.ts:61`）**同构但独立**：客户端半编译范围不含
		* `src/tfs`（会勾到 `node:fs`），故不能 import 它。两处格式必须一致，否则"已入池"判定会
		* 与本地池的实际键对不上 —— 这是本模块最容易漂移的地方，改一处必须改另一处。
		*
		* @param id - 工作项 ID。
		* @param collection - 集合名。
		* @returns 去重键。
		*/
		function requirementKey(id, collection) {
			return `${id}@${collection}`;
		}
		/** 从需求摘要取去重键（列表渲染时的行键兼已入池判定键）。 */
		function summaryKey(r) {
			return requirementKey(r.id, r.collection);
		}
		/**
		* 已领取需求的去重键集合（US2 行内标记的数据源）。
		*
		* 数据源是本地池快照 `BoardSnapshotView.requirements`——它已经在客户端手上
		* （`Workbench` 每次 `reloadBoard` 都会取），因此判定"某行是否已入池"**不需要新增任何接口**。
		*
		* @param requirements - 本地池中的已领取需求。
		* @returns 去重键数组（去重、顺序稳定 = 输入顺序）。
		*/
		function claimedKeysOf(requirements) {
			const out = /* @__PURE__ */ new Set();
			for (const r of requirements ?? []) out.add(summaryKey(r));
			return [...out];
		}
		/**
		* 可选项结果是否**值得**进缓存（US1）。
		*
		* ## 为什么不能无条件缓存
		*
		* `TfsAdapter.getQueryOptions` 逐项 try/catch：任何一项失败只把原因收进 `reason`，
		* 其余项仍可能为空。若把"四项全空"当成有效缓存写进去，一次网络抖动就会把空下拉
		* **锁死到服务重启为止** —— 比现在"慢"更糟，而且是静默的。
		*
		* 判据取「项目清单或类型清单任一非空」而非"四项都非空"：状态/指派人采集失败不该阻止
		* 复用已成功的项目与类型（降级部分可见即可用，见 FR-005）。
		*
		* @param options - 采集结果。
		* @returns true = 可写入缓存。
		*/
		function shouldCacheQueryOptions(options) {
			if (!options) return false;
			const projects = options.projects?.length ?? 0;
			const types = options.types?.length ?? 0;
			return projects > 0 || types > 0;
		}
		/** 目标正文的填充上限（防止超长正文撑爆面板，同时不把 MB 级内容塞进表单）。 */
		const TARGET_TEXT_LIMIT = 4e3;
		/** 无正文时的明确说明（空框会让用户以为功能坏了）。 */
		const EMPTY_DESCRIPTION_HINT = "（该需求在 TFS 上无正文：详细信息/需求分析/数据结构/需求配置均为空）";
		/**
		* 需求四段正文（问题 11）。
		*
		* 字段引用名为 2026-09-20 探针对「需求」工作项类型实测所得：
		* 详细信息=`System.Description`、需求分析=`Winning.Demand.Analysis`、
		* 数据结构=`Winning.Data.Design`、需求配置=`Winning.Demand.Config`。
		* 顺序即目标填充中的拼接顺序（详细信息优先，超长时从末段开始舍弃）。
		*/
		const TARGET_SECTIONS = [
			{
				heading: "详细信息",
				key: "description"
			},
			{
				heading: "需求分析",
				key: "analysis"
			},
			{
				heading: "数据结构",
				key: "dataStructure"
			},
			{
				heading: "需求配置",
				key: "config"
			}
		];
		/**
		* 取出目标需求的非空正文分段（已 trim，空段跳过）。
		* @param target - 目标需求。
		* @returns 非空分段数组。
		*/
		function targetSections(target) {
			if (!target) return [];
			const out = [];
			for (const s of TARGET_SECTIONS) {
				const v = target[s.key];
				if (typeof v === "string" && v.trim().length > 0) out.push({
					heading: s.heading,
					text: v.trim()
				});
			}
			return out;
		}
		/**
		* 截断标记（唯一一次）。
		*
		* 宽度参与 {@link composeTargetDescription} 的预算计算，因此必须在这里集中定义，
		* 不能在调用点内联——内联的那个副本一旦漏算就会让结果超出 `maxChars`。
		*/
		const TRUNCATION_MARKER = "…（已截断）";
		/**
		* 把四段正文拼成带【标题】的整体文本，并把总长度限制在 `maxChars` 内。
		*
		* 截断策略（保证截断标记最多出现一次）：按详细信息→需求分析→数据结构→需求配置的顺序逐段放入，
		* 剩余预算放不下完整下一段时，截断该段并追加一次截断标记，其后各段舍弃。
		*
		* 被舍弃的段**一定会留痕**：即使预算小到连标记都放不下，也会写出"【标题】…（已截断）"，
		* 宁可略微超出 `maxChars` 几个字符，也不让截断在界面上完全不可见。
		*
		* @param target - 目标需求。
		* @param maxChars - 总字符上限（>0）。
		* @returns 拼接文本；四段全空时返回空串。
		*/
		function composeTargetDescription(target, maxChars = TARGET_TEXT_LIMIT) {
			const sections = targetSections(target);
			if (sections.length === 0) return "";
			const parts = [];
			let used = 0;
			for (let i = 0; i < sections.length; i += 1) {
				const section = sections[i];
				if (!section) continue;
				const { heading, text } = section;
				const header = `【${heading}】\n`;
				const separator = i === sections.length - 1 ? "" : "\n\n";
				if (used + header.length + text.length + separator.length <= maxChars) {
					parts.push(`${header}${text}`);
					used += header.length + text.length + separator.length;
					continue;
				}
				const budget = maxChars - used - header.length - separator.length - 6;
				if (budget > 0) parts.push(`${header}${sliceTextByCodePoint(text, budget)}${TRUNCATION_MARKER}`);
				else parts.push(`${header}${TRUNCATION_MARKER}`);
				return parts.join("\n\n");
			}
			return parts.join("\n\n");
		}
		/**
		* 按当前执行目标生成表单填充值（US3，问题 11 扩展为四段）。
		*
		* **只在"目标变更"这一离散时机调用**，不在每次渲染时调用——否则会覆盖用户已手工编辑的内容
		* （`ExecutionPanel` 里已有同类教训：异步目录到达后写回 state 会顶掉用户选择）。
		*
		* @param target - 当前目标（未选目标时为 undefined）。
		* @returns 填充值；未选目标时返回 undefined（表单保持空白，不报错、不乱填）。
		*/
		function buildTargetFill(target) {
			if (!target) return void 0;
			const title = (target.title ?? "").trim();
			const body = composeTargetDescription(target, TARGET_TEXT_LIMIT);
			const description = body.length > 0 ? body : EMPTY_DESCRIPTION_HINT;
			const prefix = `请完成以下需求：\n${title}`;
			return {
				title,
				description,
				execPrompt: body.length > 0 ? `${prefix}\n\n${composeTargetDescription(target, Math.max(1, TARGET_TEXT_LIMIT - prefix.length - 2))}` : prefix,
				workspace: (target.workspace ?? "").trim(),
				reqPrompt: (target.prompt ?? "").trim()
			};
		}
		/**
		* 判断一次「选为目标」事件是否应把目标正文填入执行表单（spec 008 US4）。
		*
		* 旧实现用"目标键"去重（同一需求只填一次），导致同一需求第二次点「选为目标」
		* （典型路径：第一次填入 → 发起执行后表单被清空 → 再点同一目标想恢复正文）被静默跳过。
		* 现改为以**显式选择序号 nonce** 为信号：
		*
		* - 必须有目标（`hasTarget`）；
		* - nonce 为正（0 = 尚未发生过任何显式选择，面板初始挂载不填）；
		* - nonce 与上次已处理序号不同（每次点击 +1；后台轮询刷新不产生新序号，不会顶掉手工编辑）。
		*
		* @param nonce - 本次渲染携带的选择序号（`ExecutionPanelData.targetFillNonce`）。
		* @param lastFilledNonce - 本面板实例已处理过的序号（useRef 持有）。
		* @param hasTarget - 当前是否存在目标需求。
		* @returns 是否应执行填充。
		*/
		function shouldFillTarget(nonce, lastFilledNonce, hasTarget) {
			return hasTarget && nonce > 0 && nonce !== lastFilledNonce;
		}
		//#endregion
		//#region src/shared/schedule.ts
		/**
		* `<input type="datetime-local">` 的值 ↔ ISO 串。
		*
		* HTML 控件给的是 `YYYY-MM-DDTHH:mm`（本地时间、无秒、无时区后缀）。
		* 存储与比较一律用 ISO 串（`Date.prototype.toISOString()`，UTC）——
		* 落盘后跨时区/跨重启仍然单调可比，这是定时器补跑的正确性前提。
		*/
		function parseDateTimeLocal(raw, now = /* @__PURE__ */ new Date()) {
			const t = raw.trim();
			if (!t) return {
				ok: false,
				reason: "请选择执行时间（精确到分）"
			};
			const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
			if (!m) return {
				ok: false,
				reason: "时间格式应为 YYYY-MM-DD HH:mm（精确到分）"
			};
			const [, y, mo, d, h, mi, s] = m;
			const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"), 0);
			if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d) || date.getHours() !== Number(h) || date.getMinutes() !== Number(mi)) return {
				ok: false,
				reason: "时间不存在（请检查日期与小时/分钟）"
			};
			if (date.getTime() <= now.getTime()) return {
				ok: false,
				reason: "定时时间必须晚于当前时间"
			};
			return {
				ok: true,
				plan: {
					mode: "at",
					dueAt: date.toISOString()
				}
			};
		}
		/**
		* 校验一条完整的执行时机安排（弹框/表单提交时用）。
		*
		* @param input.mode - 'now' | 'at'。
		* @param input.dueAtLocal - datetime-local 控件的值（仅 mode='at' 需要）。
		* @param input.now - 当前时刻（可注入，便于测试）。
		*/
		function validateSchedule(input) {
			if ((input.mode === "at" ? "at" : "now") === "now") return {
				ok: true,
				plan: { mode: "now" }
			};
			return parseDateTimeLocal(input.dueAtLocal, input.now ?? /* @__PURE__ */ new Date());
		}
		/**
		* 把 ISO 串格式化回 `YYYY-MM-DD HH:mm`（本地时区，精确到分）。
		* 非法输入返回空串（不让 UI 显示 "Invalid Date"）。
		*/
		function formatLocalMinute(iso) {
			if (!iso) return "";
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return "";
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}
		//#endregion
		//#region src/shared/target.ts
		/**
		* 把 `id@collection` / `id@collection#stage` / 裸 id 归一成 {@link TargetRef}。
		*
		* @param key - 目标键（需求键或看板任务 id；空串表示未选目标）。
		* @param fallbackCollection - 键里没带集合时的回退集合。
		* @returns 归一后的目标（`key` 为空时返回空 `targetWorkItem`，交由调用方判有效性）。
		*/
		function targetRefFromKey(key, fallbackCollection) {
			const raw = typeof key === "string" ? key.trim() : "";
			const hash = raw.indexOf("#");
			const base = hash >= 0 ? raw.slice(0, hash) : raw;
			const at = base.indexOf("@");
			if (at < 0) return {
				targetWorkItem: base,
				collection: fallbackCollection
			};
			const collection = base.slice(at + 1);
			if (collection.length === 0) return {
				targetWorkItem: base.slice(0, at),
				collection: fallbackCollection
			};
			return {
				targetWorkItem: base,
				collection
			};
		}
		/**
		* 判断（**归一后**的）目标键是否可用于 TFS 回写：`<正整数>@<集合>`（或裸 `<正整数>`，
		* 此时集合由调用方随 `TargetRef.collection` 一起给出）。
		*
		* 面板占位符 `'—'`、空串、非数字都返回 false。调用方应先经 {@link targetRefFromKey}
		* 归一，再校验 —— 这样"用户选的目标是看板任务 id"也能正确判为有效。
		*
		* @param value - 归一后的目标键。
		* @returns 是否为有效需求键。
		*/
		function isValidTargetWorkItem(value) {
			return /^\d+(@[^#\s]+)?$/.test(typeof value === "string" ? value.trim() : "");
		}
		//#endregion
		//#region src/shared/model-route.ts
		/**
		* 把 `(provider, id)` 编码为模型下拉 option 的 value。
		* @returns JSON 复合值，形如 `{"p":"arkcode","i":"deepseek-v4-flash"}`。
		*/
		function modelOptionValue(provider, id) {
			return JSON.stringify({
				p: provider,
				i: id
			});
		}
		/**
		* 解码 {@link modelOptionValue} 复合值。
		* @returns 供应商与模型 id；非法 JSON / 字段缺失 / 空 id 时返回 undefined。
		*/
		function parseModelOptionValue(value) {
			if (typeof value !== "string" || value.length === 0) return void 0;
			let parsed;
			try {
				parsed = JSON.parse(value);
			} catch {
				return;
			}
			if (typeof parsed !== "object" || parsed === null || typeof parsed.p !== "string" || typeof parsed.i !== "string") return;
			const provider = parsed.p.trim();
			const id = parsed.i.trim();
			if (id.length === 0) return void 0;
			return {
				provider,
				id
			};
		}
		/**
		* 把扁平模型目录按 provider 分组；**同一 provider 内按 id 去重**，
		* 跨 provider 的同名模型保留为不同分组下的独立选项（这是与旧
		* RoleSettings.buildModelItems 跨 provider 去重的本质区别）。
		*
		* @param options - 宿主下发的模型目录。
		* @returns 分组列表，保持 provider 与模型在目录中的首次出现顺序。
		*/
		function groupModelOptions(options) {
			const groups = /* @__PURE__ */ new Map();
			for (const m of options ?? []) {
				if (!m || typeof m.provider !== "string" || typeof m.id !== "string" || m.id.length === 0) continue;
				const g = groups.get(m.provider) ?? {
					provider: m.provider,
					providerName: m.providerName || m.provider,
					items: []
				};
				if (!g.items.some((x) => x.id === m.id)) g.items.push(m);
				groups.set(m.provider, g);
			}
			return [...groups.values()];
		}
		/**
		* 解码下拉当前值的**宽容版**：复合值正常解析；历史裸 id（spec 009 之前落盘/缓存的值）
		* 回落为 `{ provider: '', id }`，provider 空串即"未绑定供应商，沿用父会话供应商"的旧语义。
		*
		* 与 {@link parseModelOptionValue} 的分工：后者严格（非法即 undefined，供
		* {@link modelValueExists} 判断"值是否仍在目录中"）；本函数供提交/展示侧把任何
		* 非空值都解释成一条模型路由。
		*
		* @returns 空值返回 undefined；裸 id 返回 provider 为空串的路由。
		*/
		function decodeModelValue(value) {
			const parsed = parseModelOptionValue(value);
			if (parsed) return parsed;
			if (typeof value === "string" && value.trim().length > 0) return {
				provider: "",
				id: value.trim()
			};
		}
		/** 供应商展示名：providerName → provider 路由 key → 空串。 */
		function providerLabel(options, provider) {
			if (!provider) return "";
			for (const m of options ?? []) if (m.provider === provider) return m.providerName || m.provider;
			return provider;
		}
		/**
		* 渲染「供应商 / 模型」的统一展示文案。
		* @param options - 模型目录（用于把路由 key 翻译成展示名）。
		* @param model - 模型 id。
		* @param modelProvider - 供应商路由 key（缺省=未绑定，沿用父会话供应商）。
		*/
		function formatModelRoute(options, model, modelProvider) {
			const id = model?.trim();
			if (!id) return "（默认模型）";
			const label = providerLabel(options, modelProvider);
			return label ? `${label} / ${id}` : `${id}（未绑定供应商，沿用会话供应商）`;
		}
		//#endregion
		//#region src/client/components/ExecutionPanel.tsx
		/** 问题 1：把预算输入框文本解析为非负整数；空 / 非法 / 负数一律返回 0（= 不限制）。 */
		function parseBudget(raw) {
			const t = raw.trim();
			if (!t) return 0;
			const n = Number(t);
			if (!Number.isFinite(n) || n < 0) return 0;
			return Math.floor(n);
		}
		/**
		* 表单初值。
		*
		* **刻意不写死任何"看起来合理"的默认值**（问题 4/5/6/7）：
		*   - `model` 留空 → 渲染时回落为 `data.modelOptions` 的第一项
		*     （即 dsh 真实可用模型）。写死 `deepseek-v4-flash` 会导致该模型在别的部署上不存在时，
		*     UI 显示一个下拉里根本没有的值（`<select>` 会静默显示空白，用户以为没选上）。
		*   - `workspace` 留空 → 回落为 `data.workspaces` 的第一项（dsh 已添加的工作区）。
		*   - `selectedMcp` 留空 → **不再预勾任何 MCP**。原先硬编码 `['tfs-mcp']` 有两个错：
		*     ① 固定死 MCP 名（问题 7）；② 更糟的是它把 TFS 直连能力绑给了某个 MCP 实例，
		*     让模型有绕过插件封装与写门禁的旁路（REST 化后该旁路连凭据都没有，但预勾本身仍是错的）。
		*     TFS 能力现在由插件封装工具 `tfs_req_*` 提供，不再作为"可选 MCP"出现在这里。
		*   - `preset` 留空 → 回落为 dsh 的默认预设（问题 6）。
		*/
		const DEFAULT_STATE = {
			title: "",
			description: "",
			execPrompt: "",
			reqPrompt: "",
			tags: [],
			workspace: "",
			permission: "workspace-write",
			model: "",
			preset: "",
			selectedMcp: [],
			selectedSkills: [],
			workflow: "",
			roleName: "",
			scheduleMode: "now",
			scheduleAtLocal: ""
		};
		const sectionStyle$5 = {
			border: "1px solid #e5e7eb",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12,
			background: "#fff"
		};
		const labelStyle$2 = {
			display: "block",
			fontSize: 12,
			color: "#6b7280",
			margin: "6px 0 4px"
		};
		const inputStyle$5 = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		const buttonStyle$8 = {
			padding: "8px 14px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f3f4f6",
			cursor: "pointer",
			fontSize: 13
		};
		const primaryButtonStyle$3 = {
			...buttonStyle$8,
			background: "#2563eb",
			color: "#fff",
			borderColor: "#2563eb"
		};
		const dangerButtonStyle$2 = {
			...buttonStyle$8,
			background: "#dc2626",
			color: "#fff",
			borderColor: "#dc2626"
		};
		/**
		* 执行任务配置面板。
		*/
		function ExecutionPanel(props) {
			const { data, actions } = props;
			const [form, setForm] = (0, react.useState)(DEFAULT_STATE);
			const [busy, setBusy] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)(null);
			const [maxDepthInput, setMaxDepthInput] = (0, react.useState)("");
			const [maxTokensInput, setMaxTokensInput] = (0, react.useState)("");
			const set = (key, value) => {
				setForm((prev) => ({
					...prev,
					[key]: value
				}));
			};
			const fillNonce = data.targetFillNonce ?? 0;
			const lastFilledNonceRef = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				if (!shouldFillTarget(fillNonce, lastFilledNonceRef.current, !!data.target)) return;
				lastFilledNonceRef.current = fillNonce;
				const fill = buildTargetFill(data.target);
				if (!fill) return;
				setForm((prev) => ({
					...prev,
					title: fill.title,
					description: fill.description,
					execPrompt: fill.execPrompt,
					...fill.workspace ? { workspace: fill.workspace } : {},
					reqPrompt: fill.reqPrompt
				}));
			}, [fillNonce, data.target]);
			const modelOptions = data.modelOptions ?? [];
			const workspaces = data.workspaces ?? [];
			const presets = data.presets ?? [];
			const skillOptions = data.skillOptions ?? [];
			const mcpServers = data.mcpServers ?? [];
			/**
			* 生效模型（spec 009）：下拉 value 是 `(provider, id)` 的**复合值**（见 shared/model-route.ts），
			* 未显式选择时取 dsh 真实模型清单的第一项并带上它的 provider。
			*
			* 为什么是"渲染时回落"而不是"useEffect 写回 state"：写回 state 会在目录异步到达后
			* 覆盖用户已做的选择（data 更新 → effect 跑 → 用户选的模型被第一项顶掉），
			* 是典型的"异步数据覆盖用户输入"。回落只在读取侧发生，用户一旦选过就以 state 为准。
			*/
			const firstModel = modelOptions[0];
			const fallbackModelValue = firstModel ? modelOptionValue(firstModel.provider, firstModel.id) : "";
			const effectiveModel = form.model || fallbackModelValue;
			/** 生效模型路由（复合值解码失败的历史裸值按"未绑定供应商"处理）。 */
			const effectiveRoute = decodeModelValue(effectiveModel);
			const effectiveRouteText = effectiveRoute ? formatModelRoute(modelOptions, effectiveRoute.id, effectiveRoute.provider) : "(未指定，取 dsh 默认)";
			/**
			* 生效工作目录：**只有用户显式选择过**才算数。
			*
			* 刻意**不再**回落到 `workspaces[0]`（旧行为，问题 1 的成因之一）：那会把"面板里没人选过工作区"
			* 变成"用了清单第一个工作区"，再经 `draft.workspace` 覆盖掉任务/需求上真正配置好的目录 ——
			* 用户看到的就是"我明明给任务设了 D:\…\Winning.WiNEX.Plugins，子代理却在别的工程里改代码"。
			* 未选择时留空 ⇒ 宿主按「任务级 → 需求级」回落，语义唯一且可解释。
			*
			* 注意本字段是**绝对路径**（与 `Requirement.workspace` / `TaskSnapshot.workspace` 同语义），
			* 不是 dsh 工作区的 `id`；下拉的 `value` 取 `DshWorkspaceOption.path`。
			*/
			const effectiveWorkspace = form.workspace;
			const defaultPreset = presets.find((p) => p.isDefault && !p.broken);
			const effectivePreset = form.preset || defaultPreset?.id || "";
			/**
			* 模型按 provider 分组（spec 009：分组/去重/复合值编解码统一收口到 shared/model-route.ts）。
			* 跨 provider 的同名模型保留为不同分组下的独立选项——option value 带 provider，
			* 不再出现"选火山方舟、提交裸 id 后跑成英伟达"。
			*/
			const groupedModels = (0, react.useMemo)(() => groupModelOptions(modelOptions), [modelOptions]);
			/**
			* 历史裸值兼容（spec 009）：state 里若残留旧版本写入的裸 id（非复合值），在下拉中追加一项，
			* 文案显式标注"未绑定供应商，沿用会话供应商"，避免 <select> 值不在 options 里静默显示空白。
			*/
			const legacyOptionFor = (value) => {
				if (!value || parseModelOptionValue(value)) return void 0;
				return {
					value,
					label: `${value}（未绑定供应商，沿用会话供应商）`
				};
			};
			const legacyModel = legacyOptionFor(form.model);
			/** 目录降级原因（问题 1/2）：为空串时整块不渲染。 */
			const catalogIssue = (data.catalogWarnings ?? []).filter((w) => w.trim().length > 0);
			const catalogFreshness = data.catalogCollectedAt ? `目录采集于 ${new Date(data.catalogCollectedAt).toLocaleString()}` : "目录尚未采集";
			/**
			* 派发/回写目标：**以本组件正在渲染的这份数据为准**（2026-09-21 实机事故修复）。
			*
			* 为什么不能交给宿主桥自己取：宿主下发的 `targetWorkItem` 是占位符 `'—'`（"当前目标"
			* 是客户端会话内状态），于是用户"选为目标"后，绑数据是新的、但发出去的仍是 `'—'` ⇒
			* 「确认回写」得到 *targetWorkItem 缺少有效工作项 id：—*、「发起执行」得到 `task=—#role-coder`。
			* 现在目标随这份数据显式传给动作，并在**点击前**就能判出"到底有没有选目标"。
			*/
			const targetRef = targetRefFromKey(data.targetWorkItem, data.collection);
			const targetReady = isValidTargetWorkItem(targetRef.targetWorkItem);
			/** US4 编排能力快照：宿主未接线该探测（undefined）时既不提示也不拦按钮。 */
			const orchestration = data.orchestration;
			const orchestrationBlocked = orchestration?.available === false;
			const preview = (0, react.useMemo)(() => {
				const rows = [];
				const addedTags = form.tags;
				if (addedTags.length) rows.push({
					field: "tags",
					kind: "added",
					after: addedTags
				});
				if (form.execPrompt.trim()) rows.push({
					field: "execPrompt",
					kind: "changed",
					after: form.execPrompt.slice(0, 80) + (form.execPrompt.length > 80 ? "…" : "")
				});
				if (form.selectedMcp.length) rows.push({
					field: "frozenConfig.mcp",
					kind: "changed",
					after: form.selectedMcp
				});
				if (form.selectedSkills.length) rows.push({
					field: "frozenConfig.skills",
					kind: "changed",
					after: form.selectedSkills
				});
				if (form.selectedSkills.includes(form.workflow) && form.workflow) rows.push({
					field: "frozenConfig.workflow",
					kind: "changed",
					after: form.workflow
				});
				if (form.roleName) rows.push({
					field: "roleAgent",
					kind: "changed",
					after: form.roleName
				});
				rows.push({
					field: "model",
					kind: "changed",
					after: effectiveRouteText
				});
				if (effectivePreset) rows.push({
					field: "preset",
					kind: "changed",
					after: effectivePreset
				});
				if (effectiveWorkspace) rows.push({
					field: "workspace",
					kind: "changed",
					after: effectiveWorkspace
				});
				rows.push({
					field: "permission",
					kind: "changed",
					after: form.permission
				});
				return rows;
			}, [
				form,
				effectivePreset,
				effectiveWorkspace,
				effectiveRouteText
			]);
			const addTag = (tag) => {
				const t = tag.trim();
				if (t && !form.tags.includes(t)) set("tags", [...form.tags, t]);
			};
			const onConfirmWrite = async () => {
				setBusy(true);
				setMessage(null);
				try {
					const ops = [{
						opType: "tag",
						before: [],
						after: form.tags
					}, {
						opType: "comment",
						before: null,
						after: `[DSH] 执行配置：${form.title}\n模型=${effectiveRouteText} 预设=${effectivePreset || "—"} 角色=${form.roleName} MCP=${form.selectedMcp.join(",")}`
					}];
					const res = await actions.confirmWrite(ops, targetRef);
					setMessage(res.ok ? {
						kind: "ok",
						text: "回写已执行（过四道门禁）"
					} : {
						kind: "err",
						text: res.reason ?? "回写被拒"
					});
				} catch (e) {
					setMessage({
						kind: "err",
						text: `回写失败：${e instanceof Error ? e.message : String(e)}`
					});
				} finally {
					setBusy(false);
				}
			};
			/**
			* 2026-11-03 用户诉求 1：发起执行成功后**整页重置**执行配置。
			*
			* 曾有 `resetContent`（只清标题/描述/执行 Prompt/标签、保留执行环境，问题 6）——
			* 用户明示要"重置执行配置页面"，且派发已把整套配置冻结进看板任务/定时条目，
			* 留着环境只会让下一次派发带上"上一单的环境"。故整表打回 DEFAULT_STATE
			* （含角色/模型/工作目录/技能/MCP/定时等）并清空执行预算。
			*/
			const resetAll = () => {
				setForm(DEFAULT_STATE);
				setMaxDepthInput("");
				setMaxTokensInput("");
			};
			const onDispatch = async () => {
				const scheduleCheck = validateSchedule({
					mode: form.scheduleMode,
					dueAtLocal: form.scheduleAtLocal
				});
				if (!scheduleCheck.ok) {
					setMessage({
						kind: "err",
						text: scheduleCheck.reason
					});
					return;
				}
				setBusy(true);
				setMessage(null);
				try {
					const res = await actions.dispatch({
						roleName: form.roleName,
						title: form.title.trim() || void 0,
						description: form.description.trim() || void 0,
						prompt: form.execPrompt || form.title,
						...form.reqPrompt.trim() ? { requirementPrompt: form.reqPrompt.trim() } : {},
						schedule: scheduleCheck.plan,
						frozenConfig: {
							mcp: form.selectedMcp,
							skills: form.selectedSkills,
							model: effectiveRoute?.id ?? "",
							...effectiveRoute?.provider ? { modelProvider: effectiveRoute.provider } : {},
							...form.selectedSkills.includes(form.workflow) ? { workflow: form.workflow } : {}
						},
						permission: form.permission,
						...effectivePreset ? { preset: effectivePreset } : {},
						...effectiveWorkspace ? { workspace: effectiveWorkspace } : {},
						...parseBudget(maxDepthInput) > 0 ? { maxDepth: parseBudget(maxDepthInput) } : {},
						...parseBudget(maxTokensInput) > 0 ? { maxTokens: parseBudget(maxTokensInput) } : {}
					}, void 0, targetRef);
					if (!res.ok) {
						setMessage({
							kind: "err",
							text: res.reason ?? "分发失败"
						});
						return;
					}
					if (res.scheduled) {
						const scheduledExtras = [res.workspace ? `工作目录：${res.workspace}` : "未指定工作目录（使用任务/需求上配置的目录）", "定时条目已落盘：插件重启后到点仍会执行"].filter(Boolean);
						setMessage({
							kind: "ok",
							text: `已登记定时执行：到 ${formatLocalMinute(res.scheduledAt)}（本地时间，精确到分）后主 agent 自动开始派发\n${scheduledExtras.join("\n")}`
						});
						resetAll();
						actions.onDispatched?.();
						return;
					}
					const extras = [res.createdTask && res.taskId ? `已创建看板任务 ${res.taskId}（到「任务中心」可查看执行过程）` : "", res.workspace ? `工作目录：${res.workspace}` : "未指定工作目录（使用任务/需求上配置的目录）"].filter(Boolean);
					setMessage({
						kind: "ok",
						text: `已发起执行（并发分发中）${extras.length ? `\n${extras.join("\n")}` : ""}`
					});
					resetAll();
					actions.onDispatched?.();
				} catch (e) {
					setMessage({
						kind: "err",
						text: `发起执行失败：${e instanceof Error ? e.message : String(e)}`
					});
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontFamily: "system-ui, sans-serif",
					color: "#111827",
					maxWidth: 720
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: { margin: "0 0 4px" },
						children: "执行任务配置"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 12,
							color: "#6b7280",
							marginBottom: 12
						},
						children: [
							"目标：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: data.targetWorkItem }),
							" · 集合 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: data.collection }),
							data.pluginLoadedAt && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								" · ",
								"宿主插件加载于",
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									title: "宿主半代码只在 dsh 启动时加载一次：若这个时间早于你最后一次重新构建，说明当前跑的是旧代码，需要重启 dsh",
									children: new Date(data.pluginLoadedAt).toLocaleString()
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$5,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "标题"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$5,
								value: form.title,
								onChange: (e) => set("title", e.target.value),
								placeholder: "任务标题"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "描述"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								style: {
									...inputStyle$5,
									minHeight: 56
								},
								value: form.description,
								onChange: (e) => set("description", e.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "执行 Prompt（作为子 agent 首条消息）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								style: {
									...inputStyle$5,
									minHeight: 72
								},
								value: form.execPrompt,
								onChange: (e) => set("execPrompt", e.target.value),
								placeholder: "描述该角色智能体要完成的工作"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "需求级提示词（派发时自动拼在任务提示词前；带入自任务中心，可微调）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								style: {
									...inputStyle$5,
									minHeight: 56
								},
								value: form.reqPrompt,
								onChange: (e) => set("reqPrompt", e.target.value),
								placeholder: "留空 = 沿用需求上保存的提示词"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$5,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "标签"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$5,
								list: "dsh-exec-tags",
								placeholder: "输入后回车添加",
								onKeyDown: (e) => {
									if (e.key === "Enter") {
										addTag(e.target.value);
										e.target.value = "";
									}
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
								id: "dsh-exec-tags",
								children: data.tagSuggestions.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: t }, t))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { marginTop: 6 },
								children: form.tags.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										display: "inline-block",
										background: "#eef2ff",
										color: "#3730a3",
										borderRadius: 12,
										padding: "2px 10px",
										margin: "2px 4px 2px 0",
										fontSize: 12
									},
									children: [t, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: {
											border: "none",
											background: "transparent",
											cursor: "pointer",
											marginLeft: 4,
											color: "#3730a3"
										},
										onClick: () => set("tags", form.tags.filter((x) => x !== t)),
										children: "×"
									})]
								}, t))
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$5,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									marginBottom: 8
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 12,
										color: "#6b7280"
									},
									children: catalogFreshness
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...buttonStyle$8,
										marginLeft: "auto"
									},
									disabled: busy || !actions.refreshCatalog,
									title: actions.refreshCatalog ? "重新向宿主采集模型/技能/MCP/工作区/预设清单" : "宿主未接线目录重采",
									onClick: () => {
										if (!actions.refreshCatalog) return;
										setBusy(true);
										actions.refreshCatalog().then(() => setMessage({
											kind: "ok",
											text: "能力目录已重新采集"
										})).catch((e) => setMessage({
											kind: "err",
											text: e instanceof Error ? e.message : String(e)
										})).finally(() => setBusy(false));
									},
									children: "重新采集目录"
								})]
							}),
							catalogIssue.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 11,
									color: "#b45309",
									background: "#fffbeb",
									border: "1px solid #fde68a",
									borderRadius: 6,
									padding: 6,
									marginBottom: 8,
									whiteSpace: "pre-wrap"
								},
								children: [
									"目录降级（部分数据源不可用）：",
									"\n",
									catalogIssue.join("\n")
								]
							}),
							(data.skillGroups?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "技能/MCP 分组（选中自动带出组内技能与 MCP，可继续微调）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$5,
								value: "",
								onChange: (e) => {
									const gid = e.target.value;
									if (!gid) return;
									const g = (data.skillGroups ?? []).find((x) => x.id === gid);
									if (!g) return;
									setForm((prev) => ({
										...prev,
										selectedSkills: [...new Set(g.skills)],
										selectedMcp: [...new Set(g.mcp)],
										workflow: g.skills.includes(prev.workflow) ? prev.workflow : ""
									}));
									setMessage({
										kind: "ok",
										text: `已带出分组「${g.name}」：技能 ${g.skills.length} 项、MCP ${g.mcp.length} 项（可继续微调）`
									});
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "— 选择分组带出技能/MCP —"
								}), (data.skillGroups ?? []).map((g) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: g.id,
									children: [
										g.name,
										"（技能 ",
										g.skills.length,
										" · MCP ",
										g.mcp.length,
										"）"
									]
								}, g.id))]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "MCP 选择（FrozenConfig.mcp，来自宿主真实注册实例）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
								options: mcpServers.map((m) => ({
									value: m,
									label: m
								})),
								value: form.selectedMcp,
								onChange: (next) => set("selectedMcp", next),
								placeholder: "未选择 MCP",
								searchPlaceholder: "按 server 名刷选…"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 11,
									color: "#6b7280",
									marginTop: 4
								},
								children: [
									"TFS 能力由本插件直连 REST 提供（工具名 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "tfs_req_*" }),
									"），**不需要**在这里勾任何 MCP。此处勾选的 MCP 会被**强制使用**：派发时把该 server 的真实工具全名写进子代理 prompt， 落定后核对它是否真被调用；勾了但当前没起来的 server 会在 prompt 里被标注为不可用 （不会静默当成已使用）。"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...labelStyle$2,
									marginTop: 8
								},
								children: [
									"技能选择（FrozenConfig.skills，来自 dsh 已安装技能，当前 ",
									skillOptions.length,
									" 项）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
								options: skillOptions.map((s) => ({
									value: s.name,
									label: s.name,
									hint: `${s.source}${s.modelInvocable ? " · 模型可调用" : ""}`
								})),
								value: form.selectedSkills,
								onChange: (next) => setForm((prev) => ({
									...prev,
									selectedSkills: next,
									workflow: next.includes(prev.workflow) ? prev.workflow : ""
								})),
								placeholder: "未选择技能",
								searchPlaceholder: "按技能名刷选…"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...labelStyle$2,
									marginTop: 8
								},
								children: [
									"工作流（从全部已安装技能中选择，共 ",
									skillOptions.length,
									" 项；选中即强制按该技能的流程逐步执行）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$5,
								value: form.workflow,
								onChange: (e) => {
									const next = e.target.value;
									setForm((prev) => ({
										...prev,
										workflow: next,
										selectedSkills: next && !prev.selectedSkills.includes(next) ? [...prev.selectedSkills, next] : prev.selectedSkills
									}));
								},
								disabled: skillOptions.length === 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "— 不启用工作流（自由执行）—"
								}), skillOptions.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: s.name,
									children: [s.name, form.selectedSkills.includes(s.name) ? "（已在技能中）" : ""]
								}, s.name))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 11,
									color: "#6b7280",
									marginTop: 4
								},
								children: skillOptions.length === 0 ? "宿主未返回技能清单（能力降级）：请点上方「重新采集目录」。" : "工作流 = 技能：选中后会自动加入「技能」，插件把该技能正文整篇下发，并从正文解析步骤（Phase / Step / 阶段 / 步骤 / 编号标题）。子代理必须逐步输出「✅ 步骤 i/N」，跳过任何一步都会被判为不达标。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "角色智能体（决定 provider 与默认配置）"
							}),
							"        ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$5,
								value: form.roleName,
								onChange: (e) => set("roleName", e.target.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "— 请选择 —"
								}), data.roles.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: r.name,
									children: [
										r.name,
										"（",
										r.provider,
										r.preset ? ` / ${r.preset}` : "",
										"）"
									]
								}, r.id))]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$5,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$2,
								children: "冻结快照（创建时锁定 MCP/技能/模型，运行期不可改）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									background: "#f8fafc",
									border: "1px dashed #cbd5e1",
									borderRadius: 6,
									padding: 8,
									fontSize: 12,
									fontFamily: "monospace",
									whiteSpace: "pre-wrap"
								},
								children: `<<<FREEZE\nmcp: ${form.selectedMcp.join(", ") || "—"}\nskills: ${form.selectedSkills.join(", ") || "—"}\nworkflow: ${form.selectedSkills.includes(form.workflow) && form.workflow ? `${form.workflow}（强制逐步执行）` : "—"}\nmodel: ${effectiveRouteText}\npreset: ${effectivePreset || "—"}\nworkspace: ${effectiveWorkspace || "(跟随任务/需求)"}\nrole: ${form.roleName || "—"}\nFREEZE>>>`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 12,
									flexWrap: "wrap",
									marginTop: 8
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										flex: 1,
										minWidth: 180,
										fontSize: 12,
										color: "#374151"
									},
									children: ["最大委派深度（0/空 = 不限，建议 1）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										min: 0,
										step: 1,
										style: {
											...inputStyle$5,
											marginTop: 2
										},
										value: maxDepthInput,
										onChange: (e) => setMaxDepthInput(e.target.value),
										placeholder: "如 1"
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										flex: 1,
										minWidth: 220,
										fontSize: 12,
										color: "#374151"
									},
									children: ["单次最大输出 token（0/空 = 不限）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										min: 0,
										step: 1e3,
										style: {
											...inputStyle$5,
											marginTop: 2
										},
										value: maxTokensInput,
										onChange: (e) => setMaxTokensInput(e.target.value),
										placeholder: "如 20000"
									})]
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionStyle$5,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 12,
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										flex: 1,
										minWidth: 160
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											style: labelStyle$2,
											children: "工作目录（覆盖任务/需求上的配置，留空即跟随）"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											style: inputStyle$5,
											value: workspaces.some((w) => w.path === form.workspace) ? form.workspace : form.workspace ? "__manual__" : "",
											onChange: (e) => set("workspace", e.target.value === "__manual__" ? form.workspace : e.target.value),
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "",
													children: "— 跟随任务/需求配置 —"
												}),
												workspaces.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: w.path,
													children: [w.title, w.path && w.path !== w.title ? `（${w.path}）` : ""]
												}, w.id)),
												form.workspace && !workspaces.some((w) => w.path === form.workspace) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: "__manual__",
													children: [form.workspace, "（手填）"]
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											style: {
												...inputStyle$5,
												marginTop: 4
											},
											placeholder: "或手填绝对路径，如 D:\\\\code\\\\his",
											value: form.workspace,
											onChange: (e) => set("workspace", e.target.value)
										}),
										workspaces.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 11,
												color: "#9ca3af",
												marginTop: 2
											},
											children: "宿主未返回工作区清单（能力降级）：可留空跟随任务/需求，或手填绝对路径。"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										flex: 1,
										minWidth: 160
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											style: labelStyle$2,
											children: "预设（dsh agent preset）"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											style: inputStyle$5,
											value: effectivePreset,
											onChange: (e) => set("preset", e.target.value),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: "— 不指定 —"
											}), presets.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: p.id,
												disabled: !!p.broken,
												title: p.broken ?? p.description,
												children: [
													p.name,
													p.isDefault ? "（默认）" : "",
													p.broken ? " ⚠ 损坏" : ""
												]
											}, p.id))]
										}),
										presets.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 11,
												color: "#9ca3af",
												marginTop: 2
											},
											children: "宿主未返回预设清单（能力降级）"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										flex: 1,
										minWidth: 160
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										style: labelStyle$2,
										children: "权限"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: inputStyle$5,
										value: form.permission,
										onChange: (e) => set("permission", e.target.value),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "read-only",
												children: "read-only"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "workspace-write",
												children: "workspace-write"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "danger-full-access",
												children: "danger-full-access"
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										flex: 1,
										minWidth: 200
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										style: labelStyle$2,
										children: "模型（dsh 可选模型）"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: inputStyle$5,
										value: effectiveModel,
										onChange: (e) => set("model", e.target.value),
										children: [
											groupedModels.length === 0 && !legacyModel && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: "— 宿主未返回模型 —"
											}),
											legacyModel && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: legacyModel.value,
												children: legacyModel.label
											}),
											groupedModels.map((g) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("optgroup", {
												label: g.providerName,
												children: g.items.map((m) => {
													const v = modelOptionValue(m.provider, m.id);
													return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: v,
														title: m.description ?? m.name,
														children: m.name || m.id
													}, v);
												})
											}, g.provider))
										]
									})]
								})
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...sectionStyle$5,
							background: "#f0fdf4",
							borderColor: "#86efac"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 6
								},
								children: "Dry-run 预览（确认回写前可见）"
							}),
							preview.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: "暂无变更"
							}),
							preview.map((row, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 12,
									padding: "2px 0",
									borderTop: i === 0 ? "none" : "1px solid #d1fae5"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											color: "#059669",
											fontWeight: 600
										},
										children: row.kind
									}),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: row.field }),
									row.before !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" · 前：", JSON.stringify(row.before)] }),
									row.after !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" · 后：", JSON.stringify(row.after)] })
								]
							}, i))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$5,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: labelStyle$2,
							children: "执行时机"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 16,
								alignItems: "center",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										fontSize: 13,
										cursor: "pointer"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										checked: form.scheduleMode === "now",
										onChange: () => set("scheduleMode", "now"),
										style: { marginRight: 4 }
									}), "立刻（默认）"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										fontSize: 13,
										cursor: "pointer"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										checked: form.scheduleMode === "at",
										onChange: () => set("scheduleMode", "at"),
										style: { marginRight: 4 }
									}), "定时"]
								}),
								form.scheduleMode === "at" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "datetime-local",
									style: {
										...inputStyle$5,
										width: "auto"
									},
									value: form.scheduleAtLocal,
									onChange: (e) => set("scheduleAtLocal", e.target.value)
								}),
								form.scheduleMode === "at" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "#6b7280"
									},
									children: "到点后主 agent 自动开始派发（精确到分）"
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 10,
							marginTop: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: primaryButtonStyle$3,
							disabled: busy || !targetReady,
							title: targetReady ? "" : "请先在「需求池」或「任务中心」点某个需求「选为目标」",
							onClick: onConfirmWrite,
							children: "确认回写"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: dangerButtonStyle$2,
							disabled: busy || !form.roleName || !targetReady,
							title: !form.roleName ? "请先选择角色智能体" : !targetReady ? "请先在「需求池」或「任务中心」点某个需求「选为目标」" : orchestrationBlocked ? `编排能力当前不可用（点击查看原因）：${orchestration?.reason ?? "未知原因"}` : "",
							onClick: () => {
								if (orchestrationBlocked) {
									setMessage({
										kind: "err",
										text: `未发起执行：${orchestration?.reason ?? "宿主编排能力不可用"}\n（若刚重新构建/替换过插件，请重启 dsh 后再试：宿主半代码只在启动时加载。）`
									});
									return;
								}
								onDispatch();
							},
							children: form.scheduleMode === "at" ? "定时执行" : "发起执行"
						})]
					}),
					!targetReady && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: 8,
							fontSize: 12,
							color: "#b45309"
						},
						children: [
							"当前没有有效目标（面板下发的值是 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: data.targetWorkItem || "(空)" }),
							"）： 请先到「需求池」或「任务中心」把某个需求「选为目标」，再回到本页配置执行。"
						]
					}),
					orchestrationBlocked && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: 8,
							fontSize: 12,
							color: "#b91c1c",
							background: "#fef2f2",
							border: "1px solid #fecaca",
							borderRadius: 6,
							padding: 8
						},
						children: [
							"宿主编排能力不可用（US4）：",
							orchestration?.reason ?? "未给出原因",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
							"排查：① 提示“未提供或尚未激活” ⇒ 在 profile 中确认已装载 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "@deepseek-ai/dsh-subagent" }),
							" 并重启 dsh； ② 提示“既没有 startActivation 也没有 start” ⇒ 宿主 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "@deepseek-ai/dsh-subagent" }),
							" 版本与本插件不匹配， 请升级到 0.2.1 及以上（该版本用 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "startActivation" }),
							" 取代了 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "start" }),
							"）。",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
							"（此提示每次打开本页都会重新探测，不需要重启界面。）"
						]
					}),
					orchestration?.available && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: 8,
							fontSize: 11,
							color: "#6b7280"
						},
						children: [
							"派发通道：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: orchestration.api ?? "自动" }),
							orchestration.providers.length > 0 ? ` ｜ 可用 subagent provider：${orchestration.providers.join("、")}（角色的 provider 须取其中之一）` : " ｜ 宿主未上报 provider 清单",
							orchestration.parentOnDemand ? " ｜ 当前没有活跃会话：发起时将由宿主自动恢复/新建一个会话承载子智能体（不需要先开聊天窗口）" : ""
						]
					}),
					message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginTop: 10,
							fontSize: 13,
							color: message.kind === "ok" ? "#059669" : "#dc2626",
							whiteSpace: "pre-wrap"
						},
						children: message.text
					})
				]
			});
		}
		//#endregion
		//#region src/client/board-store.ts
		/**
		* 客户端共享看板 store（问题 1 / 6 / 7）。
		*
		* ## 为什么需要它
		*
		* 改造前看板数据有三份**互不同步**的拉取逻辑：
		*   - 中央 `Workbench` 持有一份 board state，只在挂载 / 切入任务中心 / 动作后各拉一次，
		*     「执行配置 → 发起执行」后任务中心不实时同步（问题 7）；
		*   - 右栏 `SidePanel` 又是**另一份**独立 board state，与中央互不可见；
		*   - 批量派发 `dispatchBatch` 在前端用 `setInterval(1.5s) × 最多 400 轮` 全量 `getBoard`
		*     驱动 DAG（页面关闭即停，且是无意义请求风暴）。
		*
		* 本模块把看板读取收敛为**模块级单例**：
		*   1. **单飞（in-flight de-dup）**：任意时刻同一个 `getBoard` 只有一个在途请求，并发订阅者/
		*      动作共享同一个 Promise，杜绝同一内容的重复请求；
		*   2. **自适应轮询**：有任务运行中 3s 一拍、仅待人工确认 5s 一拍、全部空闲则**停止周期轮询**
		*      （看板变化在动作后由 `invalidate()` 立即拉取，或由宿主自动链式在运行期内被下一拍观测到）；
		*   3. **后台标签页暂停加速**：`document.hidden` 时放慢到 15s，不可见时不烧请求；
		*   4. **动作即失效**：所有写动作（派发 / 状态 / 编辑 / 领取 / 拆解 / 回写…）后调 `invalidate()`，
		*      立即重拉并重置节拍，中央任务中心与右栏**同一份数据**实时同步；
		*   5. **跨视图共享**：中央 main 面板与右栏 tab 即便同时挂载，也只共用这一份快照与一条轮询链。
		*
		* DAG 的自动推进已下沉到宿主（任务收口钩子 → `Board.autoStartRunnable`，问题 6），
		* 前端不再靠轮询驱动任务，轮询只用于**展示**进展，因此全空闲时可以安全停拍。
		*
		* @module @deepseek-ai/dsh-tfs-requirment/client/board-store
		*/
		/** 有任务运行中的轮询节拍（毫秒）。 */
		const RUNNING_INTERVAL_MS = 3e3;
		/** 仅有任务待人工确认时的节拍（毫秒；等人工，不必频繁）。 */
		const NEEDS_CONFIRM_INTERVAL_MS = 5e3;
		/** 看板不可用（连不上宿主）时的慢重试节拍（毫秒）。 */
		const UNAVAILABLE_INTERVAL_MS = 1e4;
		/** 后台 / 不可见标签页的统一慢节拍（毫秒）。 */
		const HIDDEN_INTERVAL_MS = 15e3;
		/** 判断任务是否仍在执行（看板态 in_progress 且执行态 running；旧数据缺 execState 时按 in_progress 视为运行中）。 */
		function isTaskRunning(t) {
			return t.state === "in_progress" && (t.execState === void 0 || t.execState === "running");
		}
		/** 判断任务是否停在「待人工确认」（问题 5）。 */
		function isTaskWaitingConfirm(t) {
			return t.state === "in_progress" && t.execState === "needs_confirmation";
		}
		/**
		* 框架无关的共享看板 store。`slots.tsx` 用宿主桥创建一个模块级单例，
		* 中央 Workbench、右栏 SidePanel、任务中心等通过 {@link useBoardStore} 订阅同一份快照。
		*/
		var BoardStore = class {
			fetcher;
			snapshot = null;
			listeners = /* @__PURE__ */ new Set();
			inflight = null;
			timer;
			/** 活跃订阅者数（React 组件挂载数）；为 0 时停止轮询链。 */
			active = 0;
			started = false;
			/** 连续失败计数（仅用于避免后台无限快重试，不对外暴露）。 */
			failures = 0;
			constructor(fetcher) {
				this.fetcher = fetcher;
			}
			/** 当前快照（可能为 null：尚未首次加载）。 */
			getSnapshot() {
				return this.snapshot;
			}
			/** 订阅快照变化；返回取消订阅函数。 */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			emit() {
				for (const l of this.listeners) try {
					l();
				} catch {}
			}
			/**
			* 拉取一次看板（**单飞**）：并发调用共享同一个在途 Promise，不会发出重复请求。
			* 拉取成功后更新快照、通知订阅者，并按新状态重排轮询节拍。
			*/
			refresh() {
				if (this.inflight) return this.inflight;
				const p = Promise.resolve().then(() => this.fetcher()).then((snap) => {
					this.snapshot = snap;
					this.failures = 0;
					this.emit();
					return snap;
				}).catch((e) => {
					this.failures += 1;
					throw e;
				}).finally(() => {
					if (this.inflight === p) this.inflight = null;
					this.schedule();
				});
				this.inflight = p;
				return p;
			}
			/**
			* 动作后调用：立即作废当前节拍并马上重拉一次（不等下一拍），
			* 让中央任务中心 / 右栏 / 角标计数实时同步（问题 7）。失败不外溢。
			*/
			invalidate() {
				this.clearTimer();
				this.refresh().catch(() => {});
			}
			/** 组件挂载时激活：首个订阅者启动轮询链并立即拉一次。 */
			activate() {
				this.active += 1;
				if (this.started) return;
				this.started = true;
				this.clearTimer();
				this.refresh().catch(() => {});
			}
			/** 组件卸载时去激活；最后一个订阅者离开后停止轮询（保留最后快照）。 */
			deactivate() {
				this.active = Math.max(0, this.active - 1);
				if (this.active === 0) {
					this.started = false;
					this.clearTimer();
				}
			}
			clearTimer() {
				if (this.timer !== void 0) {
					clearTimeout(this.timer);
					this.timer = void 0;
				}
			}
			/**
			* 计算当前状态下的轮询延迟（毫秒）；返回 0 表示**全部空闲、停止周期轮询**。
			*/
			delayFor(snap) {
				if (!snap || !snap.ok) return UNAVAILABLE_INTERVAL_MS;
				const tasks = snap.tasks ?? [];
				let delay = 0;
				if (tasks.some(isTaskRunning)) delay = RUNNING_INTERVAL_MS;
				else if (tasks.some(isTaskWaitingConfirm)) delay = NEEDS_CONFIRM_INTERVAL_MS;
				if (delay === 0) return 0;
				if (typeof document !== "undefined" && document.hidden) return HIDDEN_INTERVAL_MS;
				return delay;
			}
			/** 按当前快照状态安排下一拍（delay=0 则停拍，等待下次 invalidate/activate）。 */
			schedule() {
				this.clearTimer();
				if (!this.started || this.active === 0) return;
				const delay = this.delayFor(this.snapshot);
				if (delay <= 0) return;
				this.timer = setTimeout(() => {
					this.timer = void 0;
					this.refresh().catch(() => {});
				}, delay);
			}
		};
		/**
		* React 订阅钩子：组件挂载即激活共享轮询、卸载即去激活，返回最新看板快照。
		* 多个组件调用同一 store 时只共享一条轮询链与一份快照。
		*/
		function useBoardStore(store) {
			const [snap, setSnap] = (0, react.useState)(store.getSnapshot());
			(0, react.useEffect)(() => {
				const un = store.subscribe(() => setSnap(store.getSnapshot()));
				store.activate();
				setSnap(store.getSnapshot());
				return () => {
					un();
					store.deactivate();
				};
			}, [store]);
			return snap;
		}
		//#endregion
		//#region src/client/components/SidePanel.tsx
		/**
		* 右侧栏「TFS 执行」标签页（优化项 R1）。
		*
		* ## 为什么存在
		*
		* 中央看板是**模态**形态：打开它会顶掉会话面板，用户看不到对话、也没法边看智能体输出边改配置。
		* 而"执行配置"恰恰是最需要**与对话并排**看的内容（调完参数立刻派发、盯着执行过程）。
		* DSH 0.1.5 起官方提供了右侧栏标签页机制，正是为这种"与主区并排"的场景设计的。
		*
		* ## 与中央看板的关系：同一份数据，两个视图（不重复实现）
		*
		* 两者共用 `HttpHostBridge` 的同一批端点与同一个 `ExecutionPanel` 组件，
		* 不存在"两套逻辑各自演化"的漂移风险。区别只在承载形态：
		*
		*   | 形态 | 槽位 | 打开方式 | 典型用途 |
		*   |---|---|---|---|
		*   | 中央 `main` | `main`（keyed） | 点左侧菜单行 | 全流程：需求池 → 拆解 → 分配 → 回写 |
		*   | 右栏 `sidebar.right.pane.tab` | 同左 | 点右栏 `+` → 选「TFS 执行」 | 与对话并排调参、盯执行 |
		*
		* ## 官方扩展面（host 源码核实，非臆造）
		*
		* 右栏不是"自己往 DOM 里塞东西"，而是宿主显式开放的**两段式**协议：
		*   1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` 声明一种页类型；
		*   2. 该 id 再注册进 `sidebar.right.pane.tab` 槽（本文件下方 `registerSideTab`）。
		*
		* 依据：
		*   - 注册表服务由宿主提供：`dsh-client-ui-sidebar-right/lib/client.js` 的
		*     `ctx.reflect.provide("sidebarRightTabs", tabs)`（装配于 `dsh-web-app/cordis.patch.yml:224`）；
		*   - 定义契约：`SidebarRightTabDefinition`（`lib/types/client/tab-registry.d.ts:68-109`）——
		*     `id` 是该实现的身份，且**正是**它在 `sidebar.right.pane.tab` / `.title` 两个座席里注册用的 key；
		*   - 打开入口：`ISidebarRight.openTab(kind, options)`（`lib/types/client/service.d.ts:125`）；
		*   - 槽位契约：`sidebar.right.pane.tab` 是 `kind:'keyed'`、`scope:'session'`
		*     （宿主仓库 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2269-2312`）。
		*
		* 协议里 `'guide'` 是本包自留的 kind（`client.js` 的 `GUIDE_KIND = "guide"`），
		* 复用它会撞上已注册的 `builtin` 而抛错，故本插件自带 kind `TFS_EXEC_KIND`。
		*
		* @module @deepseek-ai/dsh-tfs-requirment/client/components/SidePanel
		*/
		/**
		* 本插件的页类型 kind。
		*
		* 必须与宿主的 `'guide'`（以及任何内建 kind）不同：注册表同一 band 内
		* 同 kind 二次注册会抛 `tab kind "x" is already registered`。
		*/
		const TFS_EXEC_KIND = "tfs-requirment-exec";
		/** 页类型在注册表里的身份，同时是它在本槽注册用的 key。 */
		const TFS_EXEC_TAB_ID = "@deepseek-ai/dsh-tfs-requirment#exec";
		/** 页签名（宿主在 chip 与浮动面板标题上渲染它）。 */
		const TFS_EXEC_TITLE = "TFS 执行";
		/** 与中央看板同源的兜底：连不上宿主时给空清单，而不是编造可选项。 */
		function emptyPanelData() {
			return {
				targetWorkItem: "—",
				collection: "—",
				roles: [],
				models: [],
				mcpServers: [],
				skills: [],
				modelOptions: [],
				workspaces: [],
				presets: [],
				providers: [],
				skillOptions: [],
				tagSuggestions: [],
				collections: [],
				pollIntervalMinutes: 5
			};
		}
		const tabButtonStyle = (active) => ({
			padding: "6px 10px",
			border: "none",
			borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
			background: "transparent",
			color: active ? "#2563eb" : "#6b7280",
			cursor: "pointer",
			fontSize: 12,
			fontWeight: active ? 600 : 400
		});
		const statusChipStyle = {
			display: "inline-block",
			padding: "1px 6px",
			borderRadius: 4,
			fontSize: 11,
			background: "#f3f4f6",
			color: "#4b5563"
		};
		/**
		* 右栏「TFS 执行」面板。
		*
		* 数据加载与中央看板同源（`bridge.getPanelData()` / `bridge.getBoard()`），
		* 因此两处永远看到同一份真实枚举，不会出现"中央有模型、右栏没有"的错位。
		*/
		function SidePanel(props) {
			const { bridge, boardStore } = props;
			const [tab, setTab] = (0, react.useState)("exec");
			const [data, setData] = (0, react.useState)(null);
			const board = useBoardStore(boardStore);
			const [target, setTarget] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [notify, setNotify] = (0, react.useState)(null);
			const orchestrationBlocked = data?.orchestration?.available === false;
			/**
			* 「重采目录」：先让宿主重采能力目录（模型 / 技能 / 预设 / 工作区 / provider / MCP），
			* 再刷新面板。这是用户在插件已打开后补配模型 / 装技能 / 加 MCP server 的**唯一自救入口**——
			* 否则右栏下拉永远停留在宿主 `apply` 期那一次采集的结果（见 `refreshPanelData` 注释）。
			*/
			const reloadCatalog = (0, react.useCallback)(() => {
				setBusy(true);
				bridge.refreshPanelData().then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
			}, [bridge]);
			(0, react.useEffect)(() => {
				reloadCatalog();
			}, [reloadCatalog]);
			const actions = (0, react.useMemo)(() => ({
				confirmWrite: (ops, ref) => bridge.confirmWrite(ops, ref),
				dispatch: async (req, taskId, ref) => {
					const res = await bridge.dispatch(req, taskId, ref);
					if (res.ok) boardStore.invalidate();
					return res;
				},
				onDispatched: () => setTab("tasks")
			}), [bridge, boardStore]);
			const openTasks = (0, react.useMemo)(() => board && board.ok ? board.tasks : new Array(), [board]);
			/**
			* 右栏宽度有限，故「执行配置」的目标直接沿用中央看板选中的需求无法共享——
			* 这里改为可从**任务中心**就地选一个任务作为目标，形成"右栏内自洽"的闭环。
			*
			* ⚠️ 目标键取任务的 **`requirementId`**（`1997179@WN_HIS`）而**不是** `taskId`
			* （`1997179@WN_HIS#analyze`）：后者按 `@` 切分会得到集合 `WN_HIS#analyze`，
			* 拿它去回写/下发只会得到更费解的失败（2026-09-21 复核）。
			*/
			const execData = (0, react.useMemo)(() => {
				const base = data ?? emptyPanelData();
				if (!target) return base;
				const ref = targetRefFromKey(target.requirementId || target.taskId, base.collection);
				return {
					...base,
					targetWorkItem: ref.targetWorkItem,
					collection: ref.collection
				};
			}, [data, target]);
			/** 就地派发一个看板任务（与中央看板 TaskCenter 的派发口径一致）。 */
			const dispatchTask = async (t) => {
				setBusy(true);
				setNotify(null);
				try {
					const role = (data?.roles ?? []).find((r) => r.name === t.roleAgent);
					const res = await bridge.dispatch({
						roleName: t.roleAgent,
						prompt: `${t.title}\n\n${t.description}`,
						frozenConfig: t.frozenConfig,
						permission: role?.defaultPermission ?? "read-only"
					}, t.taskId, targetRefFromKey(t.requirementId || t.taskId, data?.collection ?? ""));
					setNotify(res.ok ? `已派发：${t.taskId}` : `派发失败：${res.reason ?? "未知原因"}`);
					boardStore.invalidate();
				} finally {
					setBusy(false);
				}
			};
			/** 任务中心（右栏精简版）：状态 + 角色 + 派发按钮。 */
			const tasksBody = () => {
				if (!board) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: 12,
						color: "#6b7280",
						fontSize: 12
					},
					children: "加载看板中…"
				});
				if (!board.ok) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: 12,
						color: "#dc2626",
						fontSize: 12
					},
					children: ["看板不可用：", board.reason ?? "未知原因"]
				});
				if (openTasks.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: 12,
						color: "#6b7280",
						fontSize: 12
					},
					children: "暂无任务。请在中央看板「需求池」领取并拆解。"
				});
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { padding: 8 },
					children: openTasks.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							border: target?.taskId === t.taskId ? "1px solid #2563eb" : "1px solid #e5e7eb",
							borderRadius: 6,
							padding: 8,
							marginBottom: 6,
							fontSize: 12
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 6,
									alignItems: "center"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statusChipStyle,
									children: t.state
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
									style: { fontWeight: 600 },
									children: t.title
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									color: "#6b7280",
									marginTop: 4
								},
								children: [
									"角色：",
									t.roleAgent || "未分配",
									" ｜ ",
									t.taskId
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 6,
									marginTop: 6
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...tabButtonStyle(false),
										padding: "2px 8px",
										border: "1px solid #d1d5db",
										borderRadius: 4
									},
									onClick: () => {
										setTarget(t);
										setTab("exec");
									},
									children: "设为目标"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: busy || orchestrationBlocked,
									title: orchestrationBlocked ? `派发已被前置阻断：${data?.orchestration?.reason ?? "编排能力不可用"}` : void 0,
									style: {
										...tabButtonStyle(false),
										padding: "2px 8px",
										border: "1px solid #2563eb",
										borderRadius: 4,
										color: "#2563eb"
									},
									onClick: () => void dispatchTask(t),
									children: "派发"
								})]
							})
						]
					}, t.taskId))
				});
			};
			const body = () => {
				if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: 12,
						color: "#dc2626",
						fontSize: 12
					},
					children: ["数据加载失败：", error]
				});
				if (tab === "tasks") return tasksBody();
				if (!execData) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: 12,
						color: "#6b7280",
						fontSize: 12
					},
					children: "加载中…"
				});
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionPanel, {
					data: execData,
					actions
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minHeight: 0,
					background: "#fff",
					color: "#111827",
					fontFamily: "system-ui, sans-serif"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 2,
							padding: "4px 8px 0",
							borderBottom: "1px solid #e5e7eb"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: tabButtonStyle(tab === "exec"),
								onClick: () => setTab("exec"),
								children: "执行配置"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								style: tabButtonStyle(tab === "tasks"),
								onClick: () => setTab("tasks"),
								children: [
									"任务(",
									openTasks.length,
									")"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									marginLeft: "auto",
									fontSize: 11,
									color: "#9ca3af"
								},
								title: "派发目标",
								children: target ? target.taskId : "未选目标"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								title: "重采 DSH 能力目录（模型 / 技能 / 预设 / 工作区 / MCP）",
								"aria-label": "重采 DSH 能力目录",
								disabled: busy,
								onClick: () => reloadCatalog(),
								style: {
									marginLeft: 6,
									width: 22,
									height: 22,
									borderRadius: 4,
									border: "1px solid #e5e7eb",
									background: "#fff",
									color: busy ? "#9ca3af" : "#6b7280",
									cursor: busy ? "default" : "pointer",
									fontSize: 12,
									lineHeight: "18px"
								},
								children: "⟳"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								title: "收起右侧栏",
								"aria-label": "收起右侧栏",
								onClick: () => props.onClose?.(),
								style: {
									marginLeft: 6,
									width: 22,
									height: 22,
									borderRadius: 4,
									border: "1px solid #e5e7eb",
									background: "#fff",
									color: "#6b7280",
									cursor: "pointer",
									fontSize: 13,
									lineHeight: "18px"
								},
								children: "×"
							})
						]
					}),
					notify && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "4px 8px",
							fontSize: 11,
							background: "#f0f9ff",
							color: "#1e40af"
						},
						children: notify
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							flex: 1,
							minHeight: 0,
							overflowY: "auto"
						},
						children: body()
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/PaginationBar.tsx
		/**
		* 通用分页栏（问题 4 / 问题 6）。
		*
		* 纯展示组件：页码、每页条数都由父组件持有（后者还要落盘到 ui-state.json），
		* 本组件只负责渲染「共 N 条 ｜ 每页 [条数] ｜ ‹ 1 2 3 ›」并把操作上抛。
		*
		* @module @deepseek-ai/dsh-tfs-requirment/client/components/PaginationBar
		*/
		/** 需求池每页条数档位（默认 20）。 */
		const POOL_PAGE_SIZE_OPTIONS = [
			10,
			20,
			50,
			100
		];
		/** 任务中心「已领取需求」每页条数档位（默认 10）。 */
		const CLAIMED_PAGE_SIZE_OPTIONS = [
			5,
			10,
			20,
			50
		];
		/** 任务中心「任务列表」每页条数档位（默认 20）。 */
		const TASK_PAGE_SIZE_OPTIONS = [
			10,
			20,
			50,
			100
		];
		const buttonStyle$7 = {
			minWidth: 28,
			height: 26,
			padding: "0 6px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#fff",
			color: "#374151",
			cursor: "pointer",
			fontSize: 12
		};
		/**
		* 计算页码窗口（始终含首页/末页，当前页两侧各 1 页，省略号折叠）。
		*/
		function pageWindow(page, pageCount) {
			if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
			const sorted = [.../* @__PURE__ */ new Set([
				1,
				pageCount,
				page - 1,
				page,
				page + 1
			])].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
			const out = [];
			for (let i = 0; i < sorted.length; i += 1) {
				const p = sorted[i];
				if (i === 0) {
					out.push(p);
					continue;
				}
				const prev = sorted[i - 1];
				if (p - prev === 2) out.push(prev + 1);
				else if (p - prev > 2) out.push("…");
				out.push(p);
			}
			return out;
		}
		function PaginationBar(props) {
			const { total, page, pageCount, pageSize, pageSizeOptions } = props;
			if (total === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, {});
			const window = pageWindow(page, pageCount);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					flexWrap: "wrap",
					marginTop: 8,
					fontSize: 12,
					color: "#6b7280"
				},
				role: "navigation",
				"aria-label": props.label ? `${props.label}分页` : "分页",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						props.label ? `${props.label}：` : "",
						"共 ",
						total,
						" 条"
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: 4
						},
						children: [
							"每页",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								style: {
									...buttonStyle$7,
									padding: "0 4px"
								},
								value: pageSize,
								onChange: (e) => props.onPageSizeChange(Number(e.target.value)),
								"aria-label": "每页条数",
								children: pageSizeOptions.map((n) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: n,
									children: n
								}, n))
							}),
							"条"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							marginLeft: "auto",
							display: "inline-flex",
							alignItems: "center",
							gap: 4
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$7,
								disabled: page <= 1,
								onClick: () => props.onPageChange(page - 1),
								"aria-label": "上一页",
								children: "‹"
							}),
							window.map((p, i) => p === "…" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { padding: "0 2px" },
								children: "…"
							}, `ellipsis-${i}`) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...buttonStyle$7,
									...p === page ? {
										background: "#2563eb",
										borderColor: "#2563eb",
										color: "#fff",
										cursor: "default"
									} : {}
								},
								"aria-current": p === page ? "page" : void 0,
								onClick: () => props.onPageChange(p),
								children: p
							}, p)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$7,
								disabled: page >= pageCount,
								onClick: () => props.onPageChange(page + 1),
								"aria-label": "下一页",
								children: "›"
							})
						]
					})
				]
			});
		}
		/** 把每页条数规整为正整数（非法 → {@link DEFAULT_PAGE_SIZE}）。 */
		function normalizePageSize(pageSize) {
			return Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20;
		}
		/** 总页数：total<=0 或无条目时也是 1（分页栏始终停在合法页）。 */
		function pageCountFor(total, pageSize) {
			return Math.max(1, Math.ceil(Math.max(0, total) / normalizePageSize(pageSize)));
		}
		/** 把页码夹到 [1, pageCount]。 */
		function clampPage(page, pageCount) {
			return Math.min(Math.max(1, page), Math.max(1, pageCount));
		}
		/** 当前页切片（纯函数，切页不产生请求）。 */
		function paginateSlice(items, page, pageSize) {
			const size = normalizePageSize(pageSize);
			const start = (clampPage(page, pageCountFor(items.length, size)) - 1) * size;
			return items.slice(start, start + size);
		}
		/** 「第 a–b 条 / 共 n 条」用的序号区间（total=0 时 start=0）。 */
		function pageRange(total, page, pageSize) {
			const size = normalizePageSize(pageSize);
			const current = clampPage(page, pageCountFor(total, size));
			return {
				start: total <= 0 ? 0 : (current - 1) * size + 1,
				end: Math.min(total, current * size)
			};
		}
		/**
		* @param total - 条目总数。
		* @param pageSize - 每页条数（受控；调用方从 UI 状态读出并持久化）。
		*/
		function usePagination(total, pageSize) {
			const [page, setPageState] = (0, react.useState)(1);
			const safeSize = normalizePageSize(pageSize);
			const pageCount = pageCountFor(total, safeSize);
			const current = clampPage(page, pageCount);
			const setPage = (next) => setPageState(clampPage(next, pageCount));
			const resetPage = () => setPageState(1);
			const paginate = (items) => paginateSlice(items, current, safeSize);
			const range = pageRange(total, current, safeSize);
			return {
				page: current,
				pageCount,
				setPage,
				resetPage,
				paginate,
				rangeStart: range.start,
				rangeEnd: range.end
			};
		}
		//#endregion
		//#region src/shared/workitem-url.ts
		/** 是否为 `http` / `https`（其它 scheme 一律不接受）。 */
		function isHttpUrl(value) {
			return /^https?:\/\//i.test(value.trim());
		}
		/** 去掉结尾多余斜杠。 */
		function trimTrailingSlash(value) {
			return value.trim().replace(/\/+$/, "");
		}
		/**
		* 由 REST url 解析出「地址 + 集合」前缀（`/_apis/` 之前的部分）。
		*
		* @param restUrl - TFS 工作项的 REST url。
		* @returns 前缀；不含 `/_apis/` 或非法 scheme 时返回 `undefined`。
		*/
		function baseFromRestUrl(restUrl) {
			const raw = (restUrl ?? "").trim();
			if (!raw) return void 0;
			const at = raw.toLowerCase().indexOf("/_apis/");
			if (at <= 0) return void 0;
			const base = trimTrailingSlash(raw.slice(0, at));
			return isHttpUrl(base) ? base : void 0;
		}
		/**
		* 构造工作项的 TFS 网页地址（编辑页）。
		*
		* ## 失败口径（重要）
		*
		* **任何一段拿不到就返回 `undefined`**，由调用方渲染成纯文本 ——
		* 绝不产出半截 URL、也不拿占位符糊弄：一个打不开的链接比一段纯文本更糟，
		* 因为它把"数据缺失"伪装成了"功能正常"。
		*
		* @param input - 见 {@link WorkItemLinkInput}。
		* @returns 完整网页地址；构造不出时返回 `undefined`。
		*/
		function buildWorkItemUrl(input) {
			if (!Number.isInteger(input.id) || input.id <= 0) return void 0;
			let base = baseFromRestUrl(input.restUrl);
			if (base === void 0 && input.baseUrl !== void 0 && input.collection !== void 0) {
				const b = trimTrailingSlash(input.baseUrl);
				const c = trimTrailingSlash(input.collection);
				if (b && c && isHttpUrl(b)) base = `${b}/${c}`;
			}
			if (base === void 0) return void 0;
			const project = (input.project ?? "").trim();
			if (!project) return void 0;
			return `${base}/${encodeURIComponent(project)}/_workitems?id=${input.id}&_a=edit`;
		}
		//#endregion
		//#region src/client/components/RequirementPool.tsx
		/**
		* 领取弹框草稿缓存（2026-11-03 问题 2）。
		*
		* 弹框曾因遮罩 click（含"弹框内按下、遮罩上释放"的拖拽手势）被误关，已填内容
		* 随 openClaim 的重置一并丢失。现在按需求键缓存工作目录/提示词：误关、重开、
		* 甚至组件重挂载（模块级 Map 存活）都恢复得回来；领取成功才清除。
		*/
		const claimDrafts = /* @__PURE__ */ new Map();
		const sectionStyle$4 = {
			border: "1px solid #e5e7eb",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12,
			background: "#fff"
		};
		const inputStyle$4 = {
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		const buttonStyle$6 = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f9fafb",
			cursor: "pointer",
			fontSize: 13
		};
		const cellStyle$1 = {
			padding: "6px 8px",
			borderBottom: "1px solid #f1f5f9",
			fontSize: 12
		};
		/**
		* 模块级可选项缓存（问题 1 的**第二道**缓存）。
		*
		* 权威缓存是宿主数据目录的 `query-options.json`（跨会话、跨面板挂载）；这里只做
		* 同会话内的去重，配合问题 3 的 Tab 保活后基本不再触发，保留可让保活前的旧路径也不重复请求。
		* key = 集合名。
		*/
		const optionsMemory = /* @__PURE__ */ new Map();
		/** 默认每页条数（问题 4；与宿主侧默认值、PaginationBar 档位保持一致）。 */
		const DEFAULT_POOL_PAGE_SIZE = 20;
		/**
		* 需求池面板。
		* @param props.collection - 当前集合。
		* @param props.collections - 可切换集合清单。
		* @param props.onCollectionChange - 切集合。
		* @param props.listRequirements - 拉候选需求。
		* @param props.getQueryOptions - 取筛选可选项（宿主侧已改为读盘优先、未命中才采集并落盘）。
		* @param props.loadQueryOptions - 只读本地落盘可选项（问题 1，无缓存 data=null）。
		* @param props.loadUiState / saveUiState - 筛选记忆与每页条数持久化（问题 2/4）。
		* @param props.claimRequirement - 领取入池。
		* @param props.onClaimed - 领取成功回调（Workbench 刷新看板，问题 5 实时联动任务中心）。
		*/
		function RequirementPool(props) {
			const [items, setItems] = (0, react.useState)([]);
			const [loading, setLoading] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)("");
			const [options, setOptions] = (0, react.useState)(null);
			const [savedAt, setSavedAt] = (0, react.useState)("");
			const [optionsLoading, setOptionsLoading] = (0, react.useState)(false);
			const [keyword, setKeyword] = (0, react.useState)("");
			const [projects, setProjects] = (0, react.useState)([]);
			const [types, setTypes] = (0, react.useState)([]);
			const [states, setStates] = (0, react.useState)([]);
			const [assignees, setAssignees] = (0, react.useState)([]);
			const [assigneeUnlimited, setAssigneeUnlimited] = (0, react.useState)(false);
			const [unclaimedOnly, setUnclaimedOnly] = (0, react.useState)(true);
			const [poolPageSize, setPoolPageSize] = (0, react.useState)(DEFAULT_POOL_PAGE_SIZE);
			const [workspace, setWorkspace] = (0, react.useState)("");
			const [detail, setDetail] = (0, react.useState)(null);
			const [busyId, setBusyId] = (0, react.useState)(null);
			/**
			* 问题 6：领取弹框的待领取项（null = 关闭）。
			*
			* 打开时把工具栏的「默认工作目录」带进来当初始值，并清空提示词 ——
			* 提示词是"这一条需求"的，跨条目复用会造成无意的串味（比每次都重填更糟）。
			*/
			const [claimTarget, setClaimTarget] = (0, react.useState)(null);
			const [claimWorkspace, setClaimWorkspace] = (0, react.useState)("");
			const [claimPrompt, setClaimPrompt] = (0, react.useState)("");
			/** 问题 2：遮罩关闭只认"按下也在遮罩上"的 click（挡拖拽手势在遮罩上释放产生的误关）。 */
			const overlayDownTarget = (0, react.useRef)(null);
			/**
			* 已完成 UI 状态水合的集合（问题 2）：水合完成前不得把初始默认值回写覆盖磁盘上的记忆。
			*/
			const hydratedRef = (0, react.useRef)(/* @__PURE__ */ new Set());
			/**
			* 宿主每次 apply 都会新建 bridge 函数，内联进依赖会让 effect 每次渲染重跑，
			* 故用 ref 持有最新回调而依赖数组只放集合名（同 TaskCenter 的既有纪律）。
			*/
			const listRef = (0, react.useRef)(props.listRequirements);
			listRef.current = props.listRequirements;
			const getOptionsRef = (0, react.useRef)(props.getQueryOptions);
			getOptionsRef.current = props.getQueryOptions;
			const loadOptionsDiskRef = (0, react.useRef)(props.loadQueryOptions);
			loadOptionsDiskRef.current = props.loadQueryOptions;
			const loadUiStateRef = (0, react.useRef)(props.loadUiState);
			loadUiStateRef.current = props.loadUiState;
			const saveUiStateRef = (0, react.useRef)(props.saveUiState);
			saveUiStateRef.current = props.saveUiState;
			const optionsKey = props.collection || "default";
			/**
			* 问题 1：可选项**读盘优先**。
			* 顺序：同会话模块缓存 → 宿主落盘缓存（query-options.json）→ 实时采集
			* （宿主 getQueryOptions 内部同样是读盘优先 + 未命中采集并落盘，双保险）。
			*/
			(0, react.useEffect)(() => {
				let cancelled = false;
				const mem = optionsMemory.get(optionsKey);
				if (mem) {
					setOptions(mem);
					setSavedAt(mem.collectedAt ?? "");
					return;
				}
				setOptions(null);
				setSavedAt("");
				setOptionsLoading(true);
				(async () => {
					try {
						if (loadOptionsDiskRef.current) {
							const cached = await loadOptionsDiskRef.current(optionsKey === "default" ? void 0 : optionsKey);
							if (!cancelled && cached.data) {
								if (shouldCacheQueryOptions(cached.data)) optionsMemory.set(optionsKey, cached.data);
								setOptions(cached.data);
								setSavedAt(cached.savedAt ?? cached.data.collectedAt ?? "");
								return;
							}
						}
						const opts = await getOptionsRef.current(optionsKey === "default" ? void 0 : optionsKey);
						if (cancelled) return;
						if (shouldCacheQueryOptions(opts)) optionsMemory.set(optionsKey, opts);
						setOptions(opts);
						setSavedAt(opts.collectedAt ?? "");
					} catch (e) {
						if (!cancelled) setMessage(`筛选可选项不可用：${e instanceof Error ? e.message : String(e)}`);
					} finally {
						if (!cancelled) setOptionsLoading(false);
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [optionsKey]);
			/**
			* 问题 2/4：按集合水合 UI 状态（筛选记忆 + 每页条数）。
			* 无记录时回到默认（指派人默认项由随后到达的可选项补当前 PAT 用户）。
			*/
			(0, react.useEffect)(() => {
				let cancelled = false;
				const loadUi = loadUiStateRef.current;
				hydratedRef.current.delete(optionsKey);
				setProjects([]);
				setTypes([]);
				setStates([]);
				setAssignees([]);
				setAssigneeUnlimited(false);
				setPoolPageSize(DEFAULT_POOL_PAGE_SIZE);
				if (!loadUi) {
					hydratedRef.current.add(optionsKey);
					return;
				}
				(async () => {
					try {
						const ui = await loadUi(optionsKey === "default" ? void 0 : optionsKey);
						if (cancelled) return;
						const f = ui.poolFilters;
						if (f) {
							const savedProjects = f.projects ?? (f.projectId ? [f.projectId] : []);
							setProjects(savedProjects);
							setTypes(f.types ?? []);
							setStates(f.states ?? []);
							setAssignees(f.assignedTo ?? []);
							setAssigneeUnlimited(!!f.assigneeUnlimited);
						}
						if (typeof ui.poolPageSize === "number" && ui.poolPageSize > 0) setPoolPageSize(ui.poolPageSize);
					} catch {} finally {
						if (!cancelled) hydratedRef.current.add(optionsKey);
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [optionsKey]);
			/**
			* 剔除数据源里已不存在的筛选项（spec 003 FR-203「静默忽略失效值」）。
			*
			* 保存下来的筛选值是**采集那一刻**的项目/类型/状态/指派人。TFS 上有人改名或删了团队项目
			* 之后，缓存里的旧值仍留在 `ui-state.json` 里被原样恢复，并原样进入 WIQL —— 查询命中不到
			* 任何工作项，需求池变成空的，而界面上看不出任何原因（失效项在 `MultiSelect` 里渲染成一枚
			* "孤儿" chip，看上去就是一个普通的已选项）。恢复逻辑只认 `ui-state.json`，不与新采集到的
			* 可选项对账，所以这里补一次。
			*
			* 采集失败（`options.reason`）时**不动**筛选条件：此时的空列表是"没采到"而不是"没有"，
			* 据此清空会把用户的筛选全丢掉。
			*/
			(0, react.useEffect)(() => {
				if (!options || options.reason) return;
				const keep = (values, available) => {
					if (values.length === 0) return values;
					const known = new Set(available.map((o) => o.value));
					if (options.defaultAssignee) known.add(options.defaultAssignee);
					const next = values.filter((v) => known.has(v));
					return next.length === values.length ? values : next;
				};
				setProjects((prev) => keep(prev, options.projects));
				setTypes((prev) => keep(prev, options.types));
				setStates((prev) => keep(prev, options.states));
				setAssignees((prev) => keep(prev, options.assignees));
			}, [options]);
			/**
			* 可选项到达后，若水合出的筛选没有指派人且未勾选「不限」，默认勾选当前 PAT 用户
			* （"默认看自己的"；用户显式选择/记忆值不被覆盖）。
			*/
			(0, react.useEffect)(() => {
				if (!options) return;
				if (assignees.length === 0 && !assigneeUnlimited && options.defaultAssignee) setAssignees([options.defaultAssignee]);
			}, [options]);
			/** 问题 2：筛选变化防抖 300ms 落盘（水合完成后才允许写，避免默认值覆盖记忆）。 */
			(0, react.useEffect)(() => {
				if (!saveUiStateRef.current || !hydratedRef.current.has(optionsKey)) return;
				const timer = setTimeout(() => {
					saveUiStateRef.current?.({ poolFilters: {
						projects,
						types,
						states,
						assignedTo: assignees,
						assigneeUnlimited
					} }, optionsKey === "default" ? void 0 : optionsKey);
				}, 300);
				return () => clearTimeout(timer);
			}, [
				projects,
				types,
				states,
				assignees,
				assigneeUnlimited,
				optionsKey
			]);
			const claimedKeys = (0, react.useMemo)(() => new Set(claimedKeysOf(props.claimedRequirements ?? [])), [props.claimedRequirements]);
			const visibleItems = (0, react.useMemo)(() => unclaimedOnly ? items.filter((it) => !claimedKeys.has(`${it.id}@${it.collection}`)) : items, [
				items,
				unclaimedOnly,
				claimedKeys
			]);
			/** 问题 4：每页条数立即落盘并回到第 1 页。 */
			const pagination = usePagination(visibleItems.length, poolPageSize);
			const changePageSize = (size) => {
				setPoolPageSize(size);
				pagination.resetPage();
				if (saveUiStateRef.current && hydratedRef.current.has(optionsKey)) saveUiStateRef.current({ poolPageSize: size }, optionsKey === "default" ? void 0 : optionsKey);
			};
			const load = (0, react.useCallback)(async (manual) => {
				setLoading(true);
				if (manual) setMessage("");
				try {
					const filter = {
						collection: props.collection,
						projects,
						types,
						states,
						assignedTo: assigneeUnlimited ? [] : assignees.length > 0 ? assignees : void 0,
						keyword: keyword.trim() || void 0,
						top: 500
					};
					const r = await listRef.current(filter);
					if (!r.ok) {
						setMessage(r.reason ?? "查询失败");
						return;
					}
					setItems(r.items);
					if (manual) {
						pagination.resetPage();
						setMessage(`已拉取 ${r.items.length} 条候选需求`);
					}
				} catch (e) {
					setMessage(e instanceof Error ? e.message : String(e));
				} finally {
					setLoading(false);
				}
			}, [
				props.collection,
				projects,
				types,
				states,
				assignees,
				assigneeUnlimited,
				keyword
			]);
			const pollMinutes = Math.max(1, Math.trunc(props.pollIntervalMinutes ?? 5));
			/**
			* 用 ref 持最新 `load`，让计时器的依赖只留 `[pollMinutes]`。
			*
			* 旧实现把 `load` 放进依赖：而 `load` 的身份随 `projects/types/states/assignees/
			* assigneeUnlimited/keyword` 变化 ⇒ 用户每改一次筛选、或每敲一个关键词字符，
			* `clearInterval` + 重建就让 5 分钟**从零重新开始** ⇒ 频繁筛选时轮询永远不触发。
			*/
			const loadRef = (0, react.useRef)(load);
			loadRef.current = load;
			(0, react.useEffect)(() => {
				const id = setInterval(() => {
					loadRef.current(false);
				}, pollMinutes * 60 * 1e3);
				return () => clearInterval(id);
			}, [pollMinutes]);
			/** 「采集可选项」（问题 1）：强制重采并落盘覆盖，同时更新下拉。 */
			const collectOptions = async () => {
				setOptionsLoading(true);
				setMessage("");
				try {
					const fn = props.onCollectQueryOptions;
					const opts = fn ? await fn(optionsKey === "default" ? void 0 : optionsKey) : await props.getQueryOptions(optionsKey === "default" ? void 0 : optionsKey).then((data) => ({
						ok: true,
						data
					}));
					if (!opts.ok || !opts.data) {
						setMessage(opts.reason ?? "采集可选项失败");
						return;
					}
					if (shouldCacheQueryOptions(opts.data)) optionsMemory.set(optionsKey, opts.data);
					setOptions(opts.data);
					setSavedAt((/* @__PURE__ */ new Date()).toISOString());
					setMessage(shouldCacheQueryOptions(opts.data) ? "可选项已重新采集并保存到本地" : `采集未取到任何可选项${opts.reason ? `：${opts.reason}` : ""}`);
				} catch (e) {
					setMessage(e instanceof Error ? e.message : String(e));
				} finally {
					setOptionsLoading(false);
				}
			};
			const pageItems = pagination.paginate(visibleItems);
			const claim = async (item) => {
				setBusyId(item.id);
				setMessage("");
				try {
					const r = await props.claimRequirement({
						collection: item.collection,
						requirement: item,
						workspace: claimWorkspace.trim() || void 0,
						prompt: claimPrompt.trim() || void 0
					});
					if (!r.ok) {
						setMessage(r.reason ?? "领取失败");
						return;
					}
					setMessage(r.added ? `已领取 ${item.id}（已入池并打 dsh 标签）` : `${item.id} 已在池中（幂等）`);
					props.onClaimed?.();
					claimDrafts.delete(`${item.id}@${item.collection}`);
					setClaimTarget(null);
					setClaimPrompt("");
				} catch (e) {
					setMessage(e instanceof Error ? e.message : String(e));
				} finally {
					setBusyId(null);
				}
			};
			/** 打开领取弹框（问题 6）：带上工具栏里的默认工作目录；问题 2：优先恢复该需求的草稿。 */
			const openClaim = (item) => {
				setMessage("");
				const draft = claimDrafts.get(`${item.id}@${item.collection}`);
				setClaimPrompt(draft?.prompt ?? "");
				setClaimWorkspace(draft?.workspace ?? workspace.trim());
				setClaimTarget(item);
			};
			const toOptions = (arr) => arr.map((o) => ({
				value: o.value,
				label: o.label
			}));
			/**
			* 标题 → TFS 需求页（编辑页）。
			*
			* 拿不到完整信息时 `buildWorkItemUrl` 返回 `undefined`，此时**退回纯文本** ——
			* 一个打不开的链接比一段纯文本更糟（它把"数据缺失"伪装成"功能正常"）。
			*/
			const workItemUrl = (it) => buildWorkItemUrl({
				id: it.id,
				restUrl: it.url,
				project: it.project,
				baseUrl: props.tfsBaseUrl,
				collection: it.collection
			});
			/** 需求详情弹窗用的链接（可能为空）。 */
			const detailUrl = detail ? workItemUrl(detail) : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontFamily: "system-ui, sans-serif",
					color: "#111827"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							marginBottom: 12
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: { margin: 0 },
								children: "需求池"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$4,
								value: props.collection,
								onChange: (e) => props.onCollectionChange?.(e.target.value),
								disabled: !props.onCollectionChange || props.collections.length === 0,
								title: "切换 TFS 集合",
								children: [props.collections.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: props.collection,
									children: props.collection
								}), props.collections.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: c,
									children: c
								}, c))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: savedAt ? `可选项来自本地缓存（${new Date(savedAt).toLocaleString()}）` : optionsLoading ? "可选项加载中…" : "可选项尚未缓存"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$4,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 10,
									flexWrap: "wrap",
									alignItems: "flex-end"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											minWidth: 220,
											flex: "1 1 220px"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 12,
												color: "#6b7280",
												marginBottom: 4
											},
											children: "团队项目（多选，空=全部）"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
											options: toOptions(options?.projects ?? []),
											value: projects,
											onChange: (next) => {
												setProjects(next);
												pagination.resetPage();
											},
											placeholder: optionsLoading ? "可选项加载中…" : "全部项目",
											searchPlaceholder: "按项目名刷选…"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											minWidth: 180,
											flex: "1 1 180px"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 12,
												color: "#6b7280",
												marginBottom: 4
											},
											children: "工作项类型（多选）"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
											options: toOptions(options?.types ?? []),
											value: types,
											onChange: (next) => {
												setTypes(next);
												pagination.resetPage();
											},
											placeholder: "全部类型",
											searchPlaceholder: "按类型刷选…"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											minWidth: 160,
											flex: "1 1 160px"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 12,
												color: "#6b7280",
												marginBottom: 4
											},
											children: "状态（多选）"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
											options: toOptions(options?.states ?? []),
											value: states,
											onChange: (next) => {
												setStates(next);
												pagination.resetPage();
											},
											placeholder: "全部状态",
											searchPlaceholder: "按状态刷选…"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											minWidth: 200,
											flex: "1 1 200px"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												style: {
													fontSize: 12,
													color: "#6b7280",
													marginBottom: 4
												},
												children: "指派给（默认当前账号）"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
												options: toOptions(options?.assignees ?? []),
												value: assigneeUnlimited ? [] : assignees,
												onChange: (next) => {
													setAssignees(next);
													setAssigneeUnlimited(false);
													pagination.resetPage();
												},
												placeholder: assigneeUnlimited ? "不限指派人" : "默认当前账号",
												searchPlaceholder: "按账号/姓名刷选…"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: {
													display: "inline-flex",
													alignItems: "center",
													gap: 4,
													fontSize: 12,
													marginTop: 4
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: assigneeUnlimited,
													onChange: (e) => {
														setAssigneeUnlimited(e.target.checked);
														if (e.target.checked) setAssignees([]);
														pagination.resetPage();
													}
												}), "不限指派人"]
											})
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									marginTop: 10,
									flexWrap: "wrap",
									alignItems: "center"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...inputStyle$4,
											minWidth: 220
										},
										placeholder: "标题关键字",
										value: keyword,
										onChange: (e) => setKeyword(e.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "inline-flex",
											alignItems: "center",
											gap: 4,
											fontSize: 13
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: unclaimedOnly,
											onChange: (e) => {
												setUnclaimedOnly(e.target.checked);
												pagination.resetPage();
											}
										}), "仅看未入池"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...inputStyle$4,
											minWidth: 260,
											flex: "1 1 260px"
										},
										placeholder: "默认工作目录（可选，作为领取弹框的默认值，如 D:\\\\code\\\\his）",
										value: workspace,
										onChange: (e) => setWorkspace(e.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: buttonStyle$6,
										onClick: () => void load(true),
										disabled: loading,
										children: loading ? "拉取中…" : "拉取需求"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: {
											...buttonStyle$6,
											background: "#fff"
										},
										onClick: () => void collectOptions(),
										disabled: optionsLoading,
										title: "重新从 TFS 采集团队项目/工作项类型/状态/指派人，并覆盖保存到本地配置文件",
										children: optionsLoading ? "采集中…" : "采集可选项"
									})
								]
							}),
							options?.reason && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 8,
									fontSize: 12,
									color: "#b45309"
								},
								children: [
									"可选项部分采集失败：",
									options.reason,
									"（可点「采集可选项」重试）"
								]
							})
						]
					}),
					message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginBottom: 10,
							fontSize: 13,
							color: message.startsWith("已") || message.includes("成功") || message.includes("保存") ? "#047857" : "#b91c1c"
						},
						children: message
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$4,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 13,
									color: "#6b7280",
									marginBottom: 6
								},
								children: [
									"候选需求 ",
									visibleItems.length,
									" 条",
									unclaimedOnly ? "（已隐藏在池项）" : "",
									claimedKeys.size > 0 ? ` ｜ 本地池 ${claimedKeys.size} 条` : ""
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { overflowX: "auto" },
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									style: {
										width: "100%",
										borderCollapse: "collapse"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: {
											textAlign: "left",
											color: "#6b7280"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "ID"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "标题"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "类型"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "状态"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "指派给"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "项目"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle$1,
												children: "更新时间"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: cellStyle$1 })
										]
									}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [pageItems.map((it) => {
										const key = `${it.id}@${it.collection}`;
										const claimed = claimedKeys.has(key);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: claimed ? { background: "#f0f9ff" } : void 0,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle$1,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: {
															border: "none",
															background: "transparent",
															color: "#2563eb",
															cursor: "pointer",
															padding: 0,
															fontSize: 12
														},
														onClick: () => setDetail(it),
														title: "查看详情",
														children: it.id
													})
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														...cellStyle$1,
														maxWidth: 320
													},
													title: it.title,
													children: (() => {
														const href = workItemUrl(it);
														return href ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
															href,
															target: "_blank",
															rel: "noreferrer noopener",
															style: {
																color: "#2563eb",
																textDecoration: "none"
															},
															title: `在 TFS 中打开需求 #${it.id}：${href}`,
															children: [it.title, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																style: {
																	marginLeft: 4,
																	fontSize: 11,
																	color: "#6b7280"
																},
																children: "↗"
															})]
														}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: it.title });
													})()
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle$1,
													children: it.type
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle$1,
													children: it.state
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle$1,
													children: it.assignedTo
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle$1,
													children: it.project
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														...cellStyle$1,
														whiteSpace: "nowrap"
													},
													children: it.changedDate ? new Date(it.changedDate).toLocaleString() : "-"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														...cellStyle$1,
														whiteSpace: "nowrap"
													},
													children: claimed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: {
															fontSize: 12,
															color: "#0369a1"
														},
														children: "已领取"
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: buttonStyle$6,
														disabled: busyId === it.id,
														onClick: () => openClaim(it),
														children: busyId === it.id ? "领取中…" : "领取入池"
													})
												})
											]
										}, key);
									}), pageItems.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										colSpan: 8,
										style: {
											...cellStyle$1,
											color: "#9ca3af",
											textAlign: "center",
											padding: 16
										},
										children: loading ? "加载中…" : "无候选需求（设置筛选后点「拉取需求」）"
									}) })] })]
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaginationBar, {
								label: "候选需求",
								total: visibleItems.length,
								page: pagination.page,
								pageCount: pagination.pageCount,
								pageSize: poolPageSize,
								pageSizeOptions: POOL_PAGE_SIZE_OPTIONS,
								onPageChange: pagination.setPage,
								onPageSizeChange: changePageSize
							})
						]
					}),
					claimTarget && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							position: "fixed",
							inset: 0,
							background: "rgba(0,0,0,0.35)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							zIndex: 60
						},
						onMouseDown: (e) => {
							overlayDownTarget.current = e.target;
						},
						onClick: (e) => {
							if (e.target === e.currentTarget && overlayDownTarget.current === e.currentTarget) setClaimTarget(null);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								background: "#fff",
								borderRadius: 10,
								padding: 18,
								maxWidth: 640,
								width: "92%",
								maxHeight: "80vh",
								overflow: "auto"
							},
							onClick: (e) => e.stopPropagation(),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									style: { margin: "0 0 6px" },
									children: [
										"领取入池：",
										claimTarget.id,
										" ",
										claimTarget.title
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 12,
										color: "#6b7280",
										marginBottom: 12
									},
									children: [
										claimTarget.collection,
										" ｜ ",
										claimTarget.project,
										" ｜ ",
										claimTarget.type,
										" ｜ ",
										claimTarget.state
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									style: {
										display: "block",
										fontSize: 12,
										color: "#6b7280",
										margin: "6px 0 4px"
									},
									children: "工作目录（写入该需求，拆解出的任务会继承；不改变子代理进程 cwd）"
								}),
								(props.workspaces ?? []).length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									style: {
										...inputStyle$4,
										width: "100%"
									},
									value: claimWorkspace,
									onChange: (e) => {
										setClaimWorkspace(e.target.value);
										claimDrafts.set(`${claimTarget.id}@${claimTarget.collection}`, {
											workspace: e.target.value,
											prompt: claimPrompt
										});
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "— 不指定 —"
										}),
										(props.workspaces ?? []).map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: w.path,
											children: [w.title, w.path ? `（${w.path}）` : ""]
										}, w.id)),
										claimWorkspace && !(props.workspaces ?? []).some((w) => w.path === claimWorkspace) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: claimWorkspace,
											children: [claimWorkspace, "（手填）"]
										})
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 11,
										color: "#b45309"
									},
									children: "宿主未返回工作区清单（能力降级）：请手填绝对路径。"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: {
										...inputStyle$4,
										width: "100%",
										marginTop: 6
									},
									placeholder: "也可直接手填绝对路径，如 D:\\\\code\\\\his（留空 = 不指定）",
									value: claimWorkspace,
									onChange: (e) => {
										setClaimWorkspace(e.target.value);
										claimDrafts.set(`${claimTarget.id}@${claimTarget.collection}`, {
											workspace: e.target.value,
											prompt: claimPrompt
										});
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									style: {
										display: "block",
										fontSize: 12,
										color: "#6b7280",
										margin: "10px 0 4px"
									},
									children: "增加提示词（需求级；派发该需求下任一任务时拼在任务提示词之前）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									style: {
										...inputStyle$4,
										width: "100%",
										minHeight: 90,
										boxSizing: "border-box"
									},
									placeholder: "例：本次只改后端，遵循 Tjgl 代码规范；数据库变更需附回滚脚本。",
									value: claimPrompt,
									onChange: (e) => {
										setClaimPrompt(e.target.value);
										claimDrafts.set(`${claimTarget.id}@${claimTarget.collection}`, {
											workspace: claimWorkspace,
											prompt: e.target.value
										});
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										marginTop: 14,
										display: "flex",
										gap: 8,
										justifyContent: "flex-end"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: buttonStyle$6,
										disabled: busyId === claimTarget.id,
										onClick: () => void claim(claimTarget),
										children: busyId === claimTarget.id ? "领取中…" : "确认领取入池"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: buttonStyle$6,
										disabled: busyId === claimTarget.id,
										onClick: () => setClaimTarget(null),
										children: "取消"
									})]
								})
							]
						})
					}),
					detail && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							position: "fixed",
							inset: 0,
							background: "rgba(0,0,0,0.35)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							zIndex: 50
						},
						onClick: () => setDetail(null),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								background: "#fff",
								borderRadius: 10,
								padding: 18,
								maxWidth: 760,
								width: "90%",
								maxHeight: "80vh",
								overflow: "auto"
							},
							onClick: (e) => e.stopPropagation(),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "flex-start",
										gap: 8
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
										style: {
											margin: "0 0 8px",
											flex: 1
										},
										children: [
											detail.id,
											" ",
											detail.title
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: {
											...buttonStyle$6,
											padding: "2px 10px"
										},
										onClick: () => setDetail(null),
										children: "关闭"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 12,
										color: "#6b7280",
										marginBottom: 10
									},
									children: [
										detail.collection,
										" ｜ ",
										detail.project,
										" ｜ ",
										detail.type,
										" ｜ ",
										detail.state,
										" ｜ ",
										detail.assignedTo
									]
								}),
								[
									["详细信息", detail.description],
									["需求分析", detail.analysis],
									["数据结构", detail.dataStructure],
									["需求配置", detail.config]
								].map(([heading, text]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { marginBottom: 10 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											fontWeight: 600,
											color: "#374151",
											marginBottom: 2
										},
										children: heading
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											whiteSpace: "pre-wrap",
											background: "#f8fafc",
											border: "1px solid #e5e7eb",
											borderRadius: 6,
											padding: 8
										},
										children: text && text.trim() ? text : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { color: "#9ca3af" },
											children: "（空）"
										})
									})]
								}, heading)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 12,
										color: "#6b7280"
									},
									children: [
										"区域：",
										detail.areaPath,
										" ｜ 迭代：",
										detail.iterationPath,
										" ｜ 优先级：",
										detail.priority || "-"
									]
								}),
								props.onSelect && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										marginTop: 12,
										display: "flex",
										gap: 8,
										justifyContent: "flex-end",
										alignItems: "center"
									},
									children: [detailUrl && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
										href: detailUrl,
										target: "_blank",
										rel: "noreferrer noopener",
										style: {
											...buttonStyle$6,
											color: "#2563eb",
											textDecoration: "none",
											display: "inline-flex",
											alignItems: "center",
											lineHeight: "normal"
										},
										title: detailUrl,
										children: "在 TFS 中打开 ↗"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: buttonStyle$6,
										onClick: () => props.onSelect?.(detail),
										children: "选为目标"
									})]
								})
							]
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/RoleSettings.tsx
		const sectionStyle$3 = {
			border: "1px solid #e5e7eb",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12,
			background: "#fff"
		};
		const labelStyle$1 = {
			display: "block",
			fontSize: 12,
			color: "#6b7280",
			margin: "6px 0 4px"
		};
		const inputStyle$3 = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		const buttonStyle$5 = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f3f4f6",
			cursor: "pointer",
			fontSize: 13
		};
		const primaryButtonStyle$2 = {
			...buttonStyle$5,
			background: "#2563eb",
			color: "#fff",
			borderColor: "#2563eb"
		};
		/** 空角色模板（新建用；`provider` 留空，由 UI 回落到宿主 provider 清单第一项）。 */
		const EMPTY_ROLE = {
			id: "",
			name: "",
			description: "",
			provider: "",
			defaultModel: "",
			defaultMcp: [],
			defaultSkills: [],
			autoExecute: false,
			tagStrategy: "dsh"
		};
		/**
		* 角色管理面板。
		* @param props.roles - 角色清单。
		* @param props.modelOptions - dsh 真实模型清单（问题 11）。
		* @param props.skillOptions - dsh 真实技能清单（问题 11）。
		* @param props.mcpServers - 宿主真实注册的 MCP server 名清单（问题 7/11）。
		* @param props.providers - 宿主可用 subagent provider 名（问题 9 / T056 引用校验）。
		* @param props.presets - dsh 真实 agent preset 清单（问题 11）。
		* @param props.onSave - 保存回调。
		* @param props.onDelete - 删除回调（force=true 表示已确认）。
		*/
		function RoleSettings(props) {
			const [draft, setDraft] = (0, react.useState)(EMPTY_ROLE);
			const [message, setMessage] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const providers = props.providers ?? props.availableProviders ?? [];
			const modelOptions = props.modelOptions ?? [];
			const skillOptions = props.skillOptions ?? [];
			const mcpServers = props.mcpServers ?? [];
			const presets = props.presets ?? [];
			const providerMissing = (r) => providers.length > 0 && !providers.includes(r.provider);
			/** 生效 provider：空则回落到宿主清单第一项（渲染侧回落，避免异步目录覆盖用户输入）。 */
			const effectiveProvider = draft.provider || providers[0] || "";
			/** 生效 preset：空 = 不指定（preset 本来就可选，不做回落）。 */
			const effectivePreset = draft.preset ?? "";
			/** 模型按 LLM provider 分组（spec 009：跨 provider 同名模型保留为独立选项）。 */
			const groupedModels = (0, react.useMemo)(() => groupModelOptions(modelOptions), [modelOptions]);
			/**
			* 默认模型下拉的当前复合值。
			* - 新数据：defaultModelProvider + defaultModel 成对 ⇒ 复合值；
			* - 历史角色（roles.json 里只有裸 id）⇒ 保留裸值，下拉追加"未绑定供应商"项。
			*/
			const modelSelectValue = draft.defaultModel ? draft.defaultModelProvider ? modelOptionValue(draft.defaultModelProvider, draft.defaultModel) : draft.defaultModel : "";
			const legacyModel = modelSelectValue && !parseModelOptionValue(modelSelectValue) ? {
				value: modelSelectValue,
				label: `${modelSelectValue}（未绑定供应商，沿用会话供应商）`
			} : void 0;
			const edit = (r) => {
				setDraft({ ...r });
				setMessage(null);
			};
			/**
			* 问题 10：显式「新建角色」。
			*
			* 原实现只有「清空」，且清空后表单标题仍可能停在"编辑：xxx"的语境里，用户因此认为
			* "点过编辑就再也加不了新角色"。这里直接重置到 `EMPTY_ROLE` 并给明确反馈。
			*/
			const newRole = () => {
				setDraft({ ...EMPTY_ROLE });
				setMessage({
					kind: "ok",
					text: "已切换到新建模式，填写后点「保存」"
				});
			};
			const save = async () => {
				setBusy(true);
				try {
					const modelRoute = decodeModelValue(modelSelectValue);
					const role = {
						...draft,
						provider: effectiveProvider,
						id: draft.id || `role-${Date.now().toString(36)}`,
						defaultModel: modelRoute?.id ?? "",
						...modelRoute?.provider ? { defaultModelProvider: modelRoute.provider } : {},
						...effectivePreset ? { preset: effectivePreset } : {}
					};
					if (!modelRoute?.provider) delete role.defaultModelProvider;
					const res = await props.onSave(role);
					setMessage(res.ok ? {
						kind: "ok",
						text: `已保存角色「${role.name}」`
					} : {
						kind: "err",
						text: res.reason ?? "保存失败"
					});
					if (res.ok) setDraft({ ...EMPTY_ROLE });
				} finally {
					setBusy(false);
				}
			};
			const remove = async (r) => {
				setBusy(true);
				try {
					let res = await props.onDelete(r.id);
					if (!res.ok && res.references && res.references.length > 0) {
						if (globalThis.confirm?.(`角色「${r.name}」被 ${res.references.length} 处引用，仍要删除？`) ?? false) res = await props.onDelete(r.id, true);
					}
					setMessage(res.ok ? {
						kind: "ok",
						text: `已删除角色「${r.name}」`
					} : {
						kind: "err",
						text: res.reason ?? "删除失败"
					});
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontFamily: "system-ui, sans-serif",
					color: "#111827",
					maxWidth: 820
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							marginBottom: 12
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: { margin: 0 },
							children: "角色智能体管理"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...primaryButtonStyle$2,
								marginLeft: "auto"
							},
							disabled: busy,
							onClick: newRole,
							children: "＋ 新建角色"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							marginBottom: 8,
							fontSize: 12,
							color: "#6b7280"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							"模型 ",
							modelOptions.length,
							" 项 ｜ 技能 ",
							skillOptions.length,
							" 项 ｜ MCP ",
							mcpServers.length,
							" 项",
							props.catalogCollectedAt ? ` ｜ 采集于 ${new Date(props.catalogCollectedAt).toLocaleString()}` : " ｜ 目录尚未采集"
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...buttonStyle$5,
								marginLeft: "auto"
							},
							disabled: busy || !props.onRefreshCatalog,
							title: props.onRefreshCatalog ? "重新向宿主采集模型/技能/MCP 清单" : "宿主未接线目录重采",
							onClick: () => {
								if (!props.onRefreshCatalog) return;
								setBusy(true);
								props.onRefreshCatalog().then(() => setMessage({
									kind: "ok",
									text: "能力目录已重新采集"
								})).catch((e) => setMessage({
									kind: "err",
									text: e instanceof Error ? e.message : String(e)
								})).finally(() => setBusy(false));
							},
							children: "重新采集目录"
						})]
					}),
					(props.catalogWarnings ?? []).filter((w) => w.trim().length > 0).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 11,
							color: "#b45309",
							background: "#fffbeb",
							border: "1px solid #fde68a",
							borderRadius: 6,
							padding: 6,
							marginBottom: 8,
							whiteSpace: "pre-wrap"
						},
						children: [
							"目录降级（部分数据源不可用）：",
							"\n",
							(props.catalogWarnings ?? []).filter((w) => w.trim().length > 0).join("\n")
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$3,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 6
								},
								children: "现有角色"
							}),
							props.roles.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: "暂无角色，点击右上「＋ 新建角色」。"
							}),
							props.roles.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									padding: "6px 0",
									borderTop: "1px solid #f1f5f9"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											flex: 1,
											fontSize: 13
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: r.name }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: { color: "#6b7280" },
												children: [
													" · provider=",
													r.provider,
													r.preset ? ` / preset=${r.preset}` : ""
												]
											}),
											providerMissing(r) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													color: "#b45309",
													marginLeft: 8
												},
												children: "⚠ provider 在宿主不可用（T056）"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$5,
										onClick: () => edit(r),
										children: "编辑"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$5,
										disabled: busy,
										onClick: () => remove(r),
										children: "删除"
									})
								]
							}, r.id))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$3,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 6
								},
								children: draft.id ? `编辑：${draft.name || draft.id}` : "新建角色"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$1,
								children: "角色 ID（稳定主键，留空自动生成）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$3,
								value: draft.id,
								onChange: (e) => setDraft({
									...draft,
									id: e.target.value
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$1,
								children: "展示名（任务引用键，须唯一）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$3,
								value: draft.name,
								onChange: (e) => setDraft({
									...draft,
									name: e.target.value
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$1,
								children: "描述"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$3,
								value: draft.description ?? "",
								onChange: (e) => setDraft({
									...draft,
									description: e.target.value
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$1,
								children: "宿主 subagent provider（ctx.subagents.start 的 name）"
							}),
							providers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$3,
								value: draft.provider,
								placeholder: "宿主未返回 provider 清单，请手动填写",
								onChange: (e) => setDraft({
									...draft,
									provider: e.target.value
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 11,
									color: "#b45309",
									marginTop: 2
								},
								children: "宿主未返回 provider 清单（能力降级）：此处只能手填，保存后可能因 provider 不存在而不可用（T056）。"
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$3,
								value: effectiveProvider,
								onChange: (e) => setDraft({
									...draft,
									provider: e.target.value
								}),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "— 请选择 —"
								}), providers.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: p,
									children: p
								}, p))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: {
									...labelStyle$1,
									marginTop: 8
								},
								children: "agent preset（可选，dsh 预设）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$3,
								value: effectivePreset,
								onChange: (e) => setDraft({
									...draft,
									preset: e.target.value || void 0
								}),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "— 不指定 —"
								}), presets.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: p.id,
									disabled: !!p.broken,
									title: p.broken ?? p.description,
									children: [
										p.name,
										p.isDefault ? "（默认）" : "",
										p.broken ? " ⚠ 损坏" : ""
									]
								}, p.id))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...labelStyle$1,
									marginTop: 8
								},
								children: [
									"默认模型（按供应商分组，来自 dsh，当前 ",
									modelOptions.length,
									" 项）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: inputStyle$3,
								value: modelSelectValue,
								onChange: (e) => {
									const route = decodeModelValue(e.target.value);
									setDraft({
										...draft,
										defaultModel: route?.id ?? "",
										...route?.provider ? { defaultModelProvider: route.provider } : {}
									});
									if (!route?.provider) setDraft((d) => ({
										...d,
										defaultModelProvider: void 0
									}));
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: "— 未指定（派发时取 dsh 默认）—"
									}),
									legacyModel && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: legacyModel.value,
										children: legacyModel.label
									}),
									groupedModels.map((g) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("optgroup", {
										label: g.providerName,
										children: g.items.map((m) => {
											const v = modelOptionValue(m.provider, m.id);
											return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: v,
												title: m.description ?? m.name,
												children: m.name || m.id
											}, v);
										})
									}, g.provider))
								]
							}),
							groupedModels.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 11,
									color: "#b45309",
									marginTop: 2
								},
								children: "宿主未返回模型清单（能力降级）：可留空，或到「执行配置」点「重新采集目录」。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...labelStyle$1,
									marginTop: 8
								},
								children: [
									"默认 MCP（可刷选，来自宿主真实注册实例，当前 ",
									mcpServers.length,
									" 项）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
								options: mcpServers.map((m) => ({
									value: m,
									label: m
								})),
								value: draft.defaultMcp ?? [],
								onChange: (next) => setDraft({
									...draft,
									defaultMcp: next
								}),
								placeholder: "未选择 MCP",
								searchPlaceholder: "按 server 名刷选…"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: {
									...labelStyle$1,
									marginTop: 8
								},
								children: "默认技能（可刷选，来自 dsh 已安装技能）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
								options: skillOptions.map((s) => ({
									value: s.name,
									label: s.name,
									hint: `${s.source}${s.modelInvocable ? " · 模型可调用" : ""}`
								})),
								value: draft.defaultSkills ?? [],
								onChange: (next) => setDraft({
									...draft,
									defaultSkills: next
								}),
								placeholder: "未选择技能",
								searchPlaceholder: "按技能名刷选…"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle$1,
								children: "标签策略"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$3,
								value: draft.tagStrategy ?? "",
								onChange: (e) => setDraft({
									...draft,
									tagStrategy: e.target.value
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									display: "inline-flex",
									alignItems: "center",
									marginTop: 8,
									fontSize: 13
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: !!draft.autoExecute,
									onChange: (e) => setDraft({
										...draft,
										autoExecute: e.target.checked
									})
								}), "指派后自动发起执行（S-13）"]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 10,
									display: "flex",
									gap: 8
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: primaryButtonStyle$2,
									disabled: busy || !draft.name.trim(),
									onClick: save,
									children: "保存"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$5,
									disabled: busy,
									onClick: newRole,
									children: "取消编辑 / 重置"
								})]
							})
						]
					}),
					message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 13,
							color: message.kind === "ok" ? "#059669" : "#dc2626"
						},
						children: message.text
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/SkillGroupPanel.tsx
		const sectionStyle$2 = {
			border: "1px solid #e5e7eb",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12,
			background: "#fff"
		};
		const labelStyle = {
			display: "block",
			fontSize: 12,
			color: "#6b7280",
			margin: "6px 0 4px"
		};
		const inputStyle$2 = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		const buttonStyle$4 = {
			padding: "8px 14px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f3f4f6",
			cursor: "pointer",
			fontSize: 13
		};
		const primaryButtonStyle$1 = {
			...buttonStyle$4,
			background: "#2563eb",
			color: "#fff",
			borderColor: "#2563eb"
		};
		const dangerButtonStyle$1 = {
			...buttonStyle$4,
			background: "#dc2626",
			color: "#fff",
			borderColor: "#dc2626"
		};
		/** 新建分组的空白表单。 */
		function emptyDraft() {
			return {
				id: "",
				name: "",
				description: "",
				skills: [],
				mcp: [],
				createdAt: "",
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
		}
		function SkillGroupPanel(props) {
			const { groups, skillOptions, mcpServers } = props;
			/** 正在编辑的分组；null = 未在编辑。id 为空串 = 新建。 */
			const [draft, setDraft] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)(null);
			const set = (key, value) => {
				setDraft((prev) => prev ? {
					...prev,
					[key]: value
				} : prev);
			};
			const onSave = async () => {
				if (!draft) return;
				const name = draft.name.trim();
				if (!name) {
					setMessage({
						kind: "err",
						text: "请填写分组名"
					});
					return;
				}
				setBusy(true);
				setMessage(null);
				try {
					const existing = draft.id ? groups.find((g) => g.id === draft.id) : groups.find((g) => g.name.trim().toLowerCase() === name.toLowerCase());
					const id = draft.id || existing?.id || `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
					const res = await props.onSave({
						...draft,
						id,
						name,
						createdAt: existing?.createdAt ?? draft.createdAt ?? ""
					});
					if (res.ok) {
						setMessage({
							kind: "ok",
							text: `分组「${name}」已保存`
						});
						setDraft(null);
					} else setMessage({
						kind: "err",
						text: res.reason ?? "保存失败"
					});
				} catch (e) {
					setMessage({
						kind: "err",
						text: `保存失败：${e instanceof Error ? e.message : String(e)}`
					});
				} finally {
					setBusy(false);
				}
			};
			const onDelete = async (g) => {
				if (!window.confirm(`确认删除分组「${g.name}」？\n只删除本地分组记录，不影响已按该分组带出的技能/MCP 选择。`)) return;
				setBusy(true);
				setMessage(null);
				try {
					const res = await props.onDelete(g.id);
					if (res.ok) {
						setMessage({
							kind: "ok",
							text: `分组「${g.name}」已删除`
						});
						if (draft?.id === g.id) setDraft(null);
					} else setMessage({
						kind: "err",
						text: res.reason ?? "删除失败"
					});
				} catch (e) {
					setMessage({
						kind: "err",
						text: `删除失败：${e instanceof Error ? e.message : String(e)}`
					});
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontFamily: "system-ui, sans-serif",
					color: "#111827",
					maxWidth: 720
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: { margin: "0 0 4px" },
						children: "技能/MCP 分组"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 12,
							color: "#6b7280",
							marginBottom: 12
						},
						children: [
							"把常用技能 + MCP 打包成能力包：在「执行配置」或任务编辑弹框里选中分组，自动带出组内的技能与 MCP。 分组落盘在插件数据目录 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "skill-groups.json" }),
							"。"
						]
					}),
					message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginBottom: 10,
							fontSize: 13,
							color: message.kind === "ok" ? "#047857" : "#b91c1c",
							whiteSpace: "pre-wrap"
						},
						children: message.text
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$2,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									marginBottom: 8
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 13,
										fontWeight: 600
									},
									children: [
										"已有分组（",
										groups.length,
										"）"
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...primaryButtonStyle$1,
										marginLeft: "auto",
										padding: "5px 12px"
									},
									onClick: () => {
										setDraft(emptyDraft());
										setMessage(null);
									},
									children: "新建分组"
								})]
							}),
							groups.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: "还没有分组。点「新建分组」把一组常用技能 + MCP 存成能力包。"
							}),
							groups.map((g) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "flex-start",
									gap: 10,
									borderTop: "1px solid #f3f4f6",
									padding: "8px 0",
									fontSize: 12
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										flex: 1,
										minWidth: 0
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 13,
												fontWeight: 600
											},
											children: g.name
										}),
										g.description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: { color: "#6b7280" },
											children: g.description
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												color: "#4b5563",
												marginTop: 2
											},
											children: [
												"技能（",
												g.skills.length,
												"）：",
												g.skills.join("、") || "—"
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: { color: "#4b5563" },
											children: [
												"MCP（",
												g.mcp.length,
												"）：",
												g.mcp.join("、") || "—"
											]
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 6,
										whiteSpace: "nowrap"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...buttonStyle$4,
											padding: "4px 10px"
										},
										onClick: () => {
											setDraft({ ...g });
											setMessage(null);
										},
										children: "编辑"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...dangerButtonStyle$1,
											padding: "4px 10px"
										},
										disabled: busy,
										onClick: () => void onDelete(g),
										children: "删除"
									})]
								})]
							}, g.id))
						]
					}),
					draft && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...sectionStyle$2,
							borderColor: "#93c5fd"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 6
								},
								children: draft.id ? `编辑分组：${draft.name || "(未命名)"}` : "新建分组"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle,
								children: "分组名（必填；同名保存 = 覆盖该分组）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$2,
								value: draft.name,
								onChange: (e) => set("name", e.target.value),
								placeholder: "如：前端基础包 / TFS 回写包"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								style: labelStyle,
								children: "说明（可选）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle$2,
								value: draft.description ?? "",
								onChange: (e) => set("description", e.target.value),
								placeholder: "这组能力是干什么的"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: labelStyle,
								children: [
									"技能（当前可选 ",
									skillOptions.length,
									" 项）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
								options: skillOptions.map((s) => ({
									value: s.name,
									label: s.name,
									hint: `${s.source}${s.modelInvocable ? " · 模型可调用" : ""}`
								})),
								value: draft.skills,
								onChange: (next) => set("skills", next),
								placeholder: "未选择技能",
								searchPlaceholder: "按技能名刷选…"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: labelStyle,
								children: [
									"MCP（当前可选 ",
									mcpServers.length,
									" 项）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
								options: mcpServers.map((m) => ({
									value: m,
									label: m
								})),
								value: draft.mcp,
								onChange: (next) => set("mcp", next),
								placeholder: "未选择 MCP",
								searchPlaceholder: "按 server 名刷选…"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 10,
									marginTop: 12
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: primaryButtonStyle$1,
									disabled: busy,
									onClick: () => void onSave(),
									children: busy ? "保存中…" : "保存分组"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: buttonStyle$4,
									disabled: busy,
									onClick: () => setDraft(null),
									children: "取消"
								})]
							}),
							skillOptions.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 11,
									color: "#b45309",
									marginTop: 6
								},
								children: "宿主未返回技能清单（能力降级）：请到「执行配置」点「重新采集目录」后再来建分组。"
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/TaskDetailDialog.tsx
		const SCOPED_CSS = `
@keyframes td-spin { to { transform: rotate(360deg); } }
@keyframes td-pulse { 0%,100% { opacity:1; transform:scale(1);} 50% { opacity:.35; transform:scale(.8);} }
@keyframes td-fade { from { opacity:0; transform: translateY(5px);} to { opacity:1; transform:none;} }
@keyframes td-sweep { 0% { background-position: -160px 0;} 100% { background-position: 320px 0;} }
@keyframes td-barber { from { background-position: 0 0;} to { background-position: 28px 0;} }
.td-fade { animation: td-fade .28s ease both; }
.td-spin { display:inline-block; border:2px solid rgba(37,99,235,.22); border-top-color:#2563eb; border-radius:50%; animation: td-spin .7s linear infinite; flex:none; }
.td-dot { width:16px; height:16px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:10px; color:#fff; flex:none; }
.td-dot-ok { background:#10b981; } .td-dot-err { background:#ef4444; }
.td-stream { background: linear-gradient(180deg,#f8fafc 0%,#f4f6fb 100%); border:1px solid #e6e9f0; border-radius:12px; }
.td-stream-inner { scrollbar-width: thin; scrollbar-color:#c7cedb transparent; }
.td-stream-inner::-webkit-scrollbar { width:8px; height:8px; }
.td-stream-inner::-webkit-scrollbar-thumb { background:#c7cedb; border-radius:8px; }
.td-stream-inner::-webkit-scrollbar-thumb:hover { background:#aab4c6; }
.td-turn { display:flex; align-items:center; gap:8px; justify-content:center; margin:14px 0; }
.td-turn span { font-size:11px; color:#64748b; background:#eef1f6; border:1px solid #e2e7f0; border-radius:999px; padding:2px 11px; }
.td-bubble { border-radius:12px; font-size:12.5px; line-height:1.6; }
.td-bubble p { margin:0 0 6px; } .td-bubble p:last-child { margin-bottom:0; }
.td-bubble h1,.td-bubble h2,.td-bubble h3,.td-bubble h4 { margin:10px 0 5px; line-height:1.35; color:#0f172a; }
.td-bubble h1 { font-size:15px; } .td-bubble h2 { font-size:14px; } .td-bubble h3,.td-bubble h4 { font-size:13px; }
.td-bubble ul,.td-bubble ol { margin:4px 0 6px; padding-left:0; list-style:none; }
.td-bubble li { display:flex; gap:7px; margin:2px 0; }
.td-bubble li .td-li-mark { color:#6366f1; flex:none; }
.td-bubble blockquote { margin:5px 0; border-left:3px solid #c7d2fe; background:#f5f7ff; padding:4px 9px; color:#475569; border-radius:0 7px 7px 0; }
.td-bubble code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; background:#eef2ff; color:#4338ca; border-radius:4px; padding:1px 5px; }
.td-bubble pre { background:#0f172a; color:#e2e8f0; border-radius:9px; padding:10px 12px; overflow:auto; font-size:11.5px; margin:6px 0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.td-bubble pre code { background:transparent; color:inherit; padding:0; }
.td-think { border:1px solid #e7e0ff; background:#f6f3ff; border-radius:9px; margin-bottom:7px; overflow:hidden; }
.td-think > button { width:100%; display:flex; align-items:center; gap:7px; background:transparent; border:0; cursor:pointer; padding:6px 10px; font-size:11.5px; color:#6d28d9; font-weight:600; }
.td-think-body { padding:0 11px 8px 30px; font-size:12px; color:#574f72; font-style:italic; white-space:pre-wrap; line-height:1.6; }
.td-tool { border:1px solid #e7eaf1; border-radius:10px; background:#fff; margin:5px 0; overflow:hidden; transition:box-shadow .15s; }
.td-tool:hover { box-shadow:0 2px 10px rgba(15,23,42,.06); }
.td-tool-head { width:100%; display:flex; align-items:center; gap:8px; background:transparent; border:0; cursor:pointer; padding:7px 10px; text-align:left; }
.td-tool-name { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; color:#0f172a; font-weight:600; }
.td-tool-meta { margin-left:auto; font-size:10.5px; color:#94a3b8; display:inline-flex; align-items:center; gap:6px; flex:none; }
.td-tool-chev { color:#b3bccb; transition:transform .15s; flex:none; }
.td-tool-body { border-top:1px dashed #e5e9f1; padding:7px 10px 9px; }
.td-io { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; white-space:pre-wrap; word-break:break-word; background:#f8fafc; border:1px solid #e8ecf3; border-radius:7px; padding:7px 9px; margin:4px 0; }
.td-io-label { font-size:10.5px; font-weight:700; color:#64748b; letter-spacing:.3px; }
.td-tool-running { background: linear-gradient(90deg, rgba(37,99,235,.10) 25%, rgba(37,99,235,.02) 37%, rgba(37,99,235,.10) 63%); background-size:300px 100%; animation: td-sweep 1.1s linear infinite; }
.td-badge { font-size:10px; font-weight:700; border-radius:5px; padding:1px 6px; flex:none; }
.td-live-dot { width:8px; height:8px; border-radius:50%; background:#22c55e; display:inline-block; animation: td-pulse 1.3s ease-in-out infinite; }
.td-chip-btn { border-radius:8px; border:1px solid #e2e7f0; background:#fff; cursor:pointer; font-size:11.5px; padding:3px 9px; display:inline-flex; align-items:center; gap:5px; transition:all .12s; }
.td-chip-btn:hover { border-color:#c3ccd6; }
.td-chip-btn[data-active="true"] { border-color:#2563eb; background:#eff4ff; color:#1d4ed8; }
`;
		const overlayStyle$1 = {
			position: "fixed",
			inset: 0,
			background: "rgba(15,23,42,0.42)",
			backdropFilter: "blur(2px)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			zIndex: 70,
			padding: 20
		};
		const dialogStyle$1 = {
			background: "#fff",
			borderRadius: 16,
			padding: 20,
			width: "100%",
			maxWidth: 960,
			maxHeight: "92vh",
			overflow: "auto",
			display: "flex",
			flexDirection: "column",
			boxShadow: "0 24px 70px rgba(15,23,42,0.30)"
		};
		const buttonStyle$3 = {
			padding: "5px 11px",
			borderRadius: 8,
			border: "1px solid #d8dee9",
			background: "#fff",
			cursor: "pointer",
			fontSize: 12
		};
		const monoStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 11,
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			background: "#f8fafc",
			border: "1px solid #e8ecf3",
			borderRadius: 7,
			padding: 7,
			margin: "4px 0 0"
		};
		/** 工具类别徽章配色。 */
		const TOOL_BADGE = {
			mcp: {
				text: "MCP",
				color: "#1d4ed8",
				bg: "#dbeafe"
			},
			skill: {
				text: "技能",
				color: "#6d28d9",
				bg: "#ede9fe"
			},
			tool: {
				text: "工具",
				color: "#374151",
				bg: "#f1f3f7"
			}
		};
		const ATTEMPT_DOT = {
			running: "#1d4ed8",
			success: "#047857",
			failed: "#b91c1c",
			cancelled: "#6b7280"
		};
		function fmtTime(ms) {
			if (!ms) return "";
			try {
				return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
			} catch {
				return "";
			}
		}
		/** 大数字紧凑化（token 计数）。 */
		function fmtNum(n) {
			if (!n || n <= 0) return "0";
			if (n < 1e3) return String(n);
			return `${Math.round(n / 100) / 10}k`;
		}
		/** 耗时（毫秒）人性化。 */
		function fmtDuration(ms) {
			if (!ms || ms <= 0) return "—";
			if (ms < 1e3) return `${ms}ms`;
			return `${Math.round(ms / 100) / 10}s`;
		}
		/** 问题 5：取出看板任务 lastNote 中"待人工确认："后的具体原因。 */
		function stripConfirmPrefix$1(note) {
			if (!note) return "";
			const m = note.match(/^待人工确认[：:]\s*([\s\S]*)$/);
			return m && m[1] ? m[1].trim() : note;
		}
		function AssistantAvatar({ size = 28 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					width: size,
					height: size,
					borderRadius: "50%",
					background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none",
					boxShadow: "0 2px 6px rgba(99,102,241,.35)"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: size * .58,
					height: size * .58,
					viewBox: "0 0 24 24",
					fill: "none",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z",
						fill: "#fff"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "18.5",
						cy: "17",
						r: "1.6",
						fill: "#fff",
						opacity: ".85"
					})]
				})
			});
		}
		function UserAvatar({ size = 28 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					width: size,
					height: size,
					borderRadius: "50%",
					background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none",
					boxShadow: "0 2px 6px rgba(37,99,235,.35)"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: size * .55,
					height: size * .55,
					viewBox: "0 0 24 24",
					fill: "#fff",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "12",
						cy: "8",
						r: "4"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M4 20c0-3.6 3.6-5.5 8-5.5s8 1.9 8 5.5",
						stroke: "#fff",
						strokeWidth: "2",
						fill: "none",
						strokeLinecap: "round"
					})]
				})
			});
		}
		/** 行内：`code` 与 **bold**。 */
		function renderInline(text) {
			const nodes = [];
			const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
			let last = 0;
			let m;
			let k = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) nodes.push(text.slice(last, m.index));
				const tok = m[0];
				if (tok.startsWith("**")) nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: tok.slice(2, -2) }, `b${k++}`));
				else nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: tok.slice(1, -1) }, `c${k++}`));
				last = re.lastIndex;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}
		function MarkdownText({ text }) {
			const segments = text.split("```");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "td-bubble",
				children: segments.map((seg, si) => {
					if (si % 2 === 1) {
						const nl = seg.indexOf("\n");
						const code = nl >= 0 ? seg.slice(nl + 1) : seg;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: code.replace(/\n$/, "") }) }, si);
					}
					const lines = seg.split("\n");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: lines.map((raw, li) => {
						const t = raw.trim();
						if (!t) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: { height: 5 } }, li);
						const hm = /^(#{1,6})\s+(.*)$/.exec(t);
						if (hm) {
							const lvl = hm[1].length;
							const Tag = `h${Math.min(lvl, 4)}`;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, { children: renderInline(hm[2]) }, li);
						}
						const ul = /^([-*+]|•)\s+(.*)$/.exec(t);
						if (ul) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "td-li-mark",
							children: "•"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: renderInline(ul[2]) })] }) }, li);
						const ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
						if (ol) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "td-li-mark",
							children: [ol[1], "."]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: renderInline(ol[2]) })] }) }, li);
						if (/^>\s?(.*)$/.test(t)) {
							const q = /^>\s?(.*)$/.exec(t);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("blockquote", { children: renderInline(q[1]) }, li);
						}
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: renderInline(t) }, li);
					}) }, si);
				})
			});
		}
		function ThinkingBlock({ text }) {
			const [open, setOpen] = (0, react.useState)(false);
			const len = text.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "td-think",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => setOpen((v) => !v),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
							width: "13",
							height: "13",
							viewBox: "0 0 24 24",
							fill: "none",
							style: { flex: "none" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
								d: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
								stroke: "#6d28d9",
								strokeWidth: "1.7",
								strokeLinecap: "round",
								strokeLinejoin: "round"
							})
						}),
						open ? "收起思考过程" : `思考过程（${len} 字）`,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								marginLeft: "auto",
								transform: open ? "rotate(180deg)" : "none",
								transition: "transform .15s"
							},
							children: "⌄"
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "td-think-body",
					children: text
				})]
			});
		}
		function StatusLeading({ status }) {
			if (status === "running") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "td-spin",
				style: {
					width: 14,
					height: 14
				}
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: `td-dot ${status === "ok" ? "td-dot-ok" : "td-dot-err"}`,
				children: status === "ok" ? "✓" : "✕"
			});
		}
		function ToolItem({ e }) {
			const [open, setOpen] = (0, react.useState)(false);
			const badge = TOOL_BADGE[e.toolKind] ?? TOOL_BADGE.tool;
			const running = e.status === "running";
			const expandable = Boolean(e.args || e.result || e.error);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `td-fade td-tool ${running ? "td-tool-running" : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "td-tool-head",
					onClick: () => expandable && setOpen((v) => !v),
					style: { cursor: expandable ? "pointer" : "default" },
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusLeading, { status: e.status }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "td-badge",
							style: {
								color: badge.color,
								background: badge.bg
							},
							children: badge.text
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "td-tool-name",
							children: e.name
						}),
						e.status === "error" && e.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 11,
								color: "#dc2626",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: e.error.slice(0, 60)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "td-tool-meta",
							children: [running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "#2563eb" },
								children: "执行中"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [fmtTime(e.time), e.durationMs !== void 0 ? ` · ${Math.round(e.durationMs / 100) / 10}s` : ""] }), expandable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "td-tool-chev",
								style: { transform: open ? "rotate(180deg)" : "none" },
								children: "⌄"
							})]
						})
					]
				}), open && expandable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "td-tool-body",
					children: [
						e.args && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "td-io-label",
							children: "入参"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "td-io",
							children: e.args
						})] }),
						e.result && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "td-io-label",
							children: "返回结果"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "td-io",
							children: e.result
						})] }),
						e.error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "td-io-label",
							style: { color: "#dc2626" },
							children: "错误"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "td-io",
							style: {
								color: "#b91c1c",
								borderColor: "#fecaca",
								background: "#fef2f2"
							},
							children: e.error
						})] })
					]
				})]
			});
		}
		function TraceRow({ e }) {
			if (e.kind === "turn") {
				const label = e.phase === "start" ? `第 ${e.turn} 轮` : `第 ${e.turn} 轮结束${e.reason ? ` · ${e.reason}` : ""}`;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "td-turn td-fade",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: e.phase === "start" ? `● ${label}` : `■ ${label}` })
				});
			}
			if (e.kind === "user") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "td-fade",
				style: {
					display: "flex",
					alignItems: "flex-start",
					gap: 8,
					justifyContent: "flex-end",
					margin: "8px 0"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { maxWidth: "82%" },
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-bubble",
						style: {
							background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
							color: "#fff",
							padding: "8px 12px",
							boxShadow: "0 3px 10px rgba(37,99,235,.25)"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 10,
								opacity: .75,
								marginBottom: 3
							},
							children: ["指令 · ", fmtTime(e.time)]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { whiteSpace: "pre-wrap" },
							children: e.text || "（空消息）"
						})]
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UserAvatar, {})]
			});
			if (e.kind === "assistant") {
				const hasBody = e.text.trim().length > 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "td-fade",
					style: {
						display: "flex",
						alignItems: "flex-start",
						gap: 8,
						margin: "8px 0"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AssistantAvatar, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							minWidth: 0,
							flex: 1
						},
						children: [e.thinking && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThinkingBlock, { text: e.thinking }), hasBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "td-bubble",
							style: {
								background: "#fff",
								border: "1px solid #e8ecf3",
								padding: "9px 12px",
								boxShadow: "0 1px 4px rgba(15,23,42,.05)"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownText, { text: e.text }), e.interrupted && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 10,
									color: "#b45309",
									marginTop: 4
								},
								children: "（该输出被中断，为部分前缀）"
							})]
						}) : !e.thinking && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "td-bubble",
							style: {
								color: "#94a3b8",
								padding: "4px 2px"
							},
							children: "（无文本，仅发起工具调用）"
						})]
					})]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { paddingLeft: 36 },
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToolItem, { e })
			});
		}
		const statCardStyle = {
			border: "1px solid #e8ecf3",
			borderRadius: 10,
			padding: 11,
			marginBottom: 10,
			background: "#fff",
			fontSize: 12,
			boxShadow: "0 1px 4px rgba(15,23,42,.04)"
		};
		const statItemStyle = {
			display: "inline-block",
			marginRight: 16,
			marginBottom: 4
		};
		const statNumStyle = {
			fontSize: 16,
			fontWeight: 700,
			color: "#0f172a"
		};
		const statLabelStyle = {
			color: "#64748b",
			fontSize: 11,
			marginLeft: 3
		};
		function TraceStatsCard({ stats }) {
			const tk = stats.tokens;
			const cacheHit = tk.total > 0 ? Math.round((tk.cacheRead + tk.cacheWrite) / tk.total * 100) : 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: statCardStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontWeight: 700,
							fontSize: 13,
							marginBottom: 7,
							display: "flex",
							alignItems: "center",
							gap: 7
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
							width: "14",
							height: "14",
							viewBox: "0 0 24 24",
							fill: "none",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
								d: "M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3",
								stroke: "#2563eb",
								strokeWidth: "2",
								strokeLinecap: "round"
							})
						}), "执行统计（本轮）"]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: statItemStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statNumStyle,
								children: stats.modelRequests
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statLabelStyle,
								children: "模型请求"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: statItemStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statNumStyle,
								children: stats.turns
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statLabelStyle,
								children: "轮次"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: statItemStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statNumStyle,
								children: stats.userInputs
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statLabelStyle,
								children: "用户输入"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: statItemStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statNumStyle,
								children: fmtDuration(stats.durationMs)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statLabelStyle,
								children: "耗时"
							})]
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							borderTop: "1px dashed #e8ecf3",
							paddingTop: 7,
							marginTop: 3
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								title: "输入 + 缓存读 + 缓存写 + 输出（推理 token 不重复计入）",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: fmtNum(tk.total)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "token 合计"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: fmtNum(tk.input)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "输入"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: fmtNum(tk.output)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "输出"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: fmtNum(tk.cacheRead)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "缓存读"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: fmtNum(tk.cacheWrite)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "缓存写"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: fmtNum(tk.reasoning)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "推理"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										...statNumStyle,
										color: cacheHit >= 50 ? "#047857" : "#64748b"
									},
									children: [cacheHit, "%"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "缓存占比"
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							borderTop: "1px dashed #e8ecf3",
							paddingTop: 7,
							marginTop: 3
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: stats.toolCalls
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "工具调用"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									...statItemStyle,
									color: "#047857"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: stats.toolOk
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "成功"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									...statItemStyle,
									color: stats.toolError > 0 ? "#b91c1c" : "#64748b"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: stats.toolError
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "失败"
								})]
							}),
							stats.toolRunning > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									...statItemStyle,
									color: "#1d4ed8"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statNumStyle,
									children: stats.toolRunning
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: "进行中"
								})]
							}),
							stats.toolBreakdown.slice(0, 6).map((b) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statItemStyle,
								title: `${b.kind} · 成功 ${b.ok} / 失败 ${b.error}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 12,
										fontWeight: 600
									},
									children: b.name
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statLabelStyle,
									children: b.count
								})]
							}, b.name))
						]
					}),
					stats.repeatedCalls.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							borderTop: "1px dashed #e8ecf3",
							paddingTop: 7,
							marginTop: 3,
							color: "#b45309"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "重复调用（疑似无意义请求）：" }),
							stats.repeatedCalls.slice(0, 5).map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { marginRight: 12 },
								children: [
									r.name,
									" ×",
									r.count
								]
							}, r.name)),
							stats.repeatedCalls.length > 5 ? ` 等 ${stats.repeatedCalls.length} 项` : null
						]
					})
				]
			});
		}
		function TaskDetailDialog(props) {
			const attempts = props.task.attempts ?? [];
			const lastIndex = Math.max(0, attempts.length - 1);
			const [selected, setSelected] = (0, react.useState)(lastIndex);
			const [trace, setTrace] = (0, react.useState)(null);
			const [loadingTrace, setLoadingTrace] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)("");
			const [sending, setSending] = (0, react.useState)(false);
			const [followError, setFollowError] = (0, react.useState)("");
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [confirmMsg, setConfirmMsg] = (0, react.useState)(null);
			const timerRef = (0, react.useRef)(null);
			const needsConfirmation = props.task.state === "in_progress" && props.task.execState === "needs_confirmation";
			(0, react.useEffect)(() => {
				setSelected((prev) => prev > lastIndex ? lastIndex : prev === lastIndex && attempts.length ? prev : lastIndex);
			}, [attempts.length]);
			const selectedAttempt = attempts[selected];
			const isLive = props.task.execState === "running" && selected === lastIndex;
			const loadTrace = (0, react.useCallback)(async () => {
				setLoadingTrace(true);
				try {
					const r = await props.onGetTrace(props.task.taskId, attempts.length ? selected : void 0);
					setTrace(r);
				} catch (e) {
					setTrace({
						ok: false,
						taskId: props.task.taskId,
						attempt: attempts.length ? selected : -1,
						available: false,
						entries: [],
						reason: `轨迹不可用：${e instanceof Error ? e.message : String(e)}`
					});
				} finally {
					setLoadingTrace(false);
				}
			}, [
				props.task.taskId,
				selected,
				attempts.length
			]);
			(0, react.useEffect)(() => {
				loadTrace();
				if (!isLive && trace?.source !== "live") return;
				timerRef.current = setInterval(() => void loadTrace(), 2e3);
				return () => {
					if (timerRef.current) clearInterval(timerRef.current);
				};
			}, [
				loadTrace,
				isLive,
				trace?.source
			]);
			const submitFollowUp = async () => {
				const text = message.trim();
				if (!text || sending) return;
				setSending(true);
				setFollowError("");
				try {
					const r = await props.onFollowUp({
						taskId: props.task.taskId,
						message: text
					});
					if (!r.ok) {
						setFollowError(r.reason ?? "追问失败");
						return;
					}
					setMessage("");
					setSelected(r.attempt ?? lastIndex + 1);
					await props.onFollowedUp?.();
					loadTrace();
				} finally {
					setSending(false);
				}
			};
			const fc = props.task.frozenConfig;
			const deleted = props.task.state === "deleted";
			const submitConfirm = async () => {
				if (!props.onConfirm || confirming) return;
				setConfirming(true);
				setConfirmMsg(null);
				try {
					const r = await props.onConfirm();
					setConfirmMsg(r.ok ? {
						ok: true,
						text: "已确认通过，任务置为成功，下游任务将自动执行。"
					} : {
						ok: false,
						text: r.reason ?? "确认失败"
					});
					if (r.ok) await props.onFollowedUp?.();
				} catch (e) {
					setConfirmMsg({
						ok: false,
						text: e instanceof Error ? e.message : String(e)
					});
				} finally {
					setConfirming(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: overlayStyle$1,
				onClick: props.onClose,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: SCOPED_CSS }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: dialogStyle$1,
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "flex-start",
								gap: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { flex: 1 },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									style: {
										margin: "0 0 5px",
										fontSize: 17,
										display: "flex",
										alignItems: "center",
										gap: 9
									},
									children: [props.task.title, isLive && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											display: "inline-flex",
											alignItems: "center",
											gap: 5,
											fontSize: 11,
											color: "#16a34a",
											fontWeight: 600
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "td-live-dot" }), " 执行中"]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 11,
										color: "#64748b",
										fontFamily: "ui-monospace, monospace"
									},
									children: props.task.taskId
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$3,
								onClick: props.onClose,
								children: "关闭"
							})]
						}),
						needsConfirmation && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								border: "1px solid #fed7aa",
								background: "linear-gradient(135deg,#fff7ed,#ffedd5)",
								color: "#9a3412",
								borderRadius: 12,
								padding: 12,
								margin: "12px 0",
								fontSize: 12
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontWeight: 700,
										fontSize: 13,
										marginBottom: 5,
										display: "flex",
										alignItems: "center",
										gap: 6
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
										width: "15",
										height: "15",
										viewBox: "0 0 24 24",
										fill: "none",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
											d: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
											stroke: "#c2410c",
											strokeWidth: "1.8",
											strokeLinecap: "round",
											strokeLinejoin: "round"
										})
									}), "待人工确认"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										whiteSpace: "pre-wrap",
										marginBottom: 7
									},
									children: stripConfirmPrefix$1(props.task.lastNote) || selectedAttempt?.output || "子代理已产出结论并提示需要人工确认。请核对下方执行过程，确认无误后放行；如有问题可在底部追问后重新执行。"
								}),
								props.onConfirm && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...buttonStyle$3,
										background: "#c2410c",
										color: "#fff",
										borderColor: "#c2410c",
										fontWeight: 600
									},
									disabled: confirming,
									onClick: () => void submitConfirm(),
									children: confirming ? "确认中…" : "确认通过（置成功并自动执行下游）"
								}),
								confirmMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										marginTop: 7,
										color: confirmMsg.ok ? "#047857" : "#b91c1c"
									},
									children: confirmMsg.text
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							style: { margin: "12px 0 4px" },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
								style: {
									cursor: "pointer",
									fontSize: 12,
									color: "#475569",
									fontWeight: 600
								},
								children: "冻结配置（角色 / 模型 / 工作目录 / 技能 / 工作流 / MCP / 预设 / 预算）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 11.5,
									color: "#334155",
									background: "#f8fafc",
									border: "1px solid #e8ecf3",
									borderRadius: 10,
									padding: 10,
									marginTop: 7,
									lineHeight: 1.9
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "角色" }),
										" ",
										props.task.roleAgent,
										" ｜",
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "模型" }),
										" ",
										fc.model ? formatModelRoute(null, fc.model, fc.modelProvider) : "（角色默认）",
										" ｜",
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "工作目录" }),
										" ",
										props.task.workspace || "未接线"
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "技能" }),
										" ",
										fc.skills.length ? fc.skills.join("、") : "无",
										" ｜ ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "工作流" }),
										" ",
										fc.workflow ? `${fc.workflow}（强制逐步）` : "未启用",
										" ｜ ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "MCP" }),
										" ",
										fc.mcp.length ? fc.mcp.join("、") : "无"
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "预设" }),
										" ",
										fc.preset || "（不指定）",
										" ｜ ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "最大深度" }),
										" ",
										fc.maxDepth && fc.maxDepth > 0 ? fc.maxDepth : "不限",
										" ｜ ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "单次输出上限" }),
										" ",
										fc.maxTokens && fc.maxTokens > 0 ? `${fc.maxTokens} tokens` : "不限"
									] })
								]
							})]
						}),
						attempts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								gap: 6,
								flexWrap: "wrap",
								margin: "10px 0"
							},
							children: attempts.map((a, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => setSelected(i),
								className: "td-chip-btn",
								"data-active": i === selected,
								title: a.diagnostic ?? a.note ?? "",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
										width: 8,
										height: 8,
										borderRadius: "50%",
										background: ATTEMPT_DOT[a.outcome] ?? "#9ca3af",
										display: "inline-block"
									} }),
									"第 ",
									i + 1,
									" 轮"
								]
							}, `${a.startedAt}-${i}`))
						}),
						selectedAttempt?.outcome === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								border: "1px solid #fecaca",
								background: "linear-gradient(135deg,#fef2f2,#fee2e2)",
								color: "#991b1b",
								borderRadius: 12,
								padding: 12,
								marginBottom: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontWeight: 700,
										fontSize: 13,
										marginBottom: 5
									},
									children: "本轮执行失败"
								}),
								selectedAttempt.stopReason && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 11,
										marginBottom: 4
									},
									children: ["终止原因：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: selectedAttempt.stopReason })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 12,
										whiteSpace: "pre-wrap"
									},
									children: selectedAttempt.diagnostic ?? selectedAttempt.note ?? "未返回失败诊断（可能是基础设施异常或子会话不可读）。"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "td-stream",
							style: {
								flex: 1,
								padding: 12,
								minHeight: 200,
								maxHeight: "52vh",
								display: "flex",
								flexDirection: "column"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									marginBottom: 8,
									flex: "none"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", {
										style: {
											fontSize: 13,
											display: "flex",
											alignItems: "center",
											gap: 6
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
											width: "14",
											height: "14",
											viewBox: "0 0 24 24",
											fill: "none",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
												cx: "12",
												cy: "12",
												r: "9",
												stroke: "#6366f1",
												strokeWidth: "2"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
												d: "M12 7v5l3 2",
												stroke: "#6366f1",
												strokeWidth: "2",
												strokeLinecap: "round"
											})]
										}), "执行过程"]
									}),
									trace?.truncated && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											fontSize: 11,
											color: "#b45309"
										},
										children: [
											"事件过多，仅保留首尾（共 ",
											trace.total,
											" 条）"
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "td-chip-btn",
										style: { marginLeft: "auto" },
										disabled: loadingTrace,
										onClick: () => void loadTrace(),
										children: loadingTrace ? "加载中…" : "刷新"
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-stream-inner",
								style: {
									flex: 1,
									overflow: "auto",
									paddingRight: 4
								},
								children: [
									trace?.available && trace.stats && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
										open: selectedAttempt?.outcome !== "success",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
											style: {
												cursor: "pointer",
												fontSize: 12,
												color: "#475569",
												fontWeight: 600,
												marginBottom: 6
											},
											children: "请求 / token / 工具统计"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TraceStatsCard, { stats: trace.stats })]
									}),
									!trace && loadingTrace && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											color: "#64748b"
										},
										children: "正在读取子会话事件…"
									}),
									trace && !trace.available && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 12,
											color: "#92400e",
											background: "#fffbeb",
											border: "1px solid #fde68a",
											borderRadius: 10,
											padding: 11
										},
										children: [
											"暂无执行过程：",
											trace.reason ?? "会话轨迹不可读",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												style: {
													marginTop: 5,
													color: "#a16207",
													fontSize: 11
												},
												children: "任务尚未派发、子会话已不可读、或宿主未提供 sessionQuery 时会出现此提示。失败原因仍可在上方诊断框查看。"
											})
										]
									}),
									trace?.available && trace.entries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											color: "#64748b"
										},
										children: "该轮暂无可展示事件。"
									}),
									trace?.available && trace.entries.map((e, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TraceRow, { e }, i))
								]
							})]
						}),
						selectedAttempt?.output && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							style: { marginTop: 8 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
								style: {
									cursor: "pointer",
									fontSize: 12,
									color: "#475569"
								},
								children: "本轮原始输出摘要"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								style: monoStyle,
								children: selectedAttempt.output
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 14,
								borderTop: "1px solid #e8ecf3",
								paddingTop: 12
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									style: {
										display: "block",
										fontSize: 12,
										fontWeight: 600,
										marginBottom: 5
									},
									children: "二次对话 / 追问补充（同角色、同模型与工具配置起新一轮执行）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									style: {
										width: "100%",
										boxSizing: "border-box",
										minHeight: 68,
										padding: 9,
										borderRadius: 10,
										border: "1px solid #d8dee9",
										fontSize: 13,
										fontFamily: "inherit",
										resize: "vertical"
									},
									placeholder: deleted ? "任务已取消，不可追问。" : "例：失败原因是 401，请检查鉴权头后重试；或：再补充处理 xx 分支。",
									value: message,
									disabled: sending || deleted,
									onChange: (e) => setMessage(e.target.value)
								}),
								followError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										color: "#b91c1c",
										fontSize: 12,
										marginTop: 4
									},
									children: followError
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										display: "flex",
										justifyContent: "flex-end",
										gap: 8,
										marginTop: 7
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...buttonStyle$3,
											background: "#2563eb",
											color: "#fff",
											borderColor: "#2563eb",
											fontWeight: 600
										},
										disabled: sending || deleted || !message.trim(),
										onClick: () => void submitFollowUp(),
										children: sending ? "提交中…" : "追问并重新执行"
									})
								})
							]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/shared/chat-address.ts
		/**
		* 「子会话对话」资源地址的编解码（US4 / AC4.5）。
		*
		* ## 格式来源（已核实，不臆造）
		*
		* 宿主 `ui-subagent` 的侧边对话（`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:21,51-89`）：
		*
		* ```
		* dsh-resource://subagentchat/session/<encodeURIComponent(childSessionId)>?parent=<parentSessionId>&mode=<mode>
		* ```
		*
		* `mode` 只接受 `one-shot` / `continuable` / `unknown` 三个字面量（同文件 `:76`）。
		*
		* ## 为什么不直接 import 宿主的 `subagentChatAddress`
		*
		* 客户端半只能 require `PLATFORM_MODULES`
		* （`packages/client/web/src/platform.ts:8-14`），其中**没有** `@deepseek-ai/dsh-subagent/client`，
		* 也没有 `ui-subagent`。故本模块按已核实的格式自行实现（纯字符串处理，可单测），
		* 与宿主实现**格式对齐**而非共享代码。
		*
		* @module @deepseek-ai/dsh-tfs-requirment/shared/chat-address
		*/
		/** 宿主侧边对话的资源协议前缀（`ui-subagent/.../sidebar-chat/index.tsx:21`）。 */
		const SUBAGENT_CHAT_ADDRESS = "dsh-resource://subagentchat/session/";
		/**
		* 构造子会话对话地址。
		*
		* @param address - 会话三元组。
		* @returns 规范地址；父会话 id 为空时返回空串（地址不可用，调用方应降级而不是造一个坏地址）。
		*/
		function buildChatAddress(address) {
			const child = (address.childSessionId ?? "").trim();
			const parent = (address.parentSessionId ?? "").trim();
			if (!child || !parent) return "";
			const query = new URLSearchParams({
				parent,
				mode: address.mode
			});
			return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(child)}?${query}`;
		}
		//#endregion
		//#region src/shared/chat-panel.ts
		/**
		* 计算会话体相位。
		*
		* ## 口径来源（已核实，不得漂移）
		*
		* 宿主官方侧边对话 `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:132-147`
		* 的 `ConversationSlotPanel`：
		*
		* ```ts
		* const active = conversation.activeTargets.size > 0
		*   || (!session.blank && !session.awaitingFirstTurn)
		*   || session.running
		* const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
		* const parentAvailabilityPending = session.subagent?.address.mode === 'continuable'
		*   && session.subagent.parentAvailable === undefined
		* const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true)
		*   || parentAvailabilityPending
		* const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
		* const phase = settling ? 'settling' : hero ? 'hero' : 'active'
		* ```
		*
		* 本函数**逐字同式**。此前插件自拟的口径缺 `settling` 分支：会话重挂后历史窗口
		* 还在 loading 时会被画成 `active`（输入框浮到顶端、转录区空白，2026-11-03 用户截图），
		* 而官方此时是 `settling`（composer 隐藏、无错误布局）。
		*
		* @param input - 相位输入。
		* @returns 相位结果（phase/hero 与壳相位明细）。
		*/
		function computeChatPhase(input) {
			const { activeTargetsSize, session, summaryBlank } = input;
			const shellPhase = activeTargetsSize > 0 || !session.blank && !session.awaitingFirstTurn || Boolean(session.running) ? "active" : session.promptAttempted ? "engaging" : "blank";
			const parentAvailabilityPending = session.subagent?.address?.mode === "continuable" && session.subagent?.parentAvailable === void 0;
			const settling = shellPhase === "blank" && session.openState === "loading" && summaryBlank !== true || parentAvailabilityPending;
			const hero = shellPhase === "blank" && (session.openState === "open" || summaryBlank === true);
			return {
				phase: settling ? "settling" : hero ? "hero" : "active",
				hero,
				shellPhase,
				settling,
				parentAvailabilityPending
			};
		}
		/**
		* 推导主对话框的焦点需求键。
		*
		* 优先级：**显式行点选** > 需求筛选下拉 > 首条进行中需求；
		* 前两档**都必须仍在进行中才生效**（不在进行中即回落下一档）。
		*
		* 为什么前两档都要校验"仍在进行中"：焦点键指向的是正在跑编排的需求，
		* 已完成需求的任务表本来就被剔除（`TaskCenter` 的 `activeTasks`），
		* 若允许焦点停在失效键上，会出现"焦点行标记无处可落 / 对话框与任务表各指一处"
		* 的分裂状态（2026-11-03 问题 1 口径收口）。
		*
		* 为什么要有"显式行点选"：此前只有「筛选下拉 > 首条」两档（`TaskCenter` 旧口径），
		* 多个需求同时执行时对话框永远停在第一条，用户根本不知道下拉还能切对话框
		* （2026-11-03 问题 1）。行点选是唯一与「已领取需求列表」直接绑定的切换入口。
		*
		* @param input - 推导输入。
		* @returns 焦点需求键（无可选需求时为 ''）。
		*/
		function resolveChatFocusKey(input) {
			const { explicitKey, requirementFilter, activeRequirementKeys } = input;
			if (explicitKey && activeRequirementKeys.includes(explicitKey)) return explicitKey;
			if (requirementFilter && activeRequirementKeys.includes(requirementFilter)) return requirementFilter;
			return activeRequirementKeys[0] ?? "";
		}
		/**
		* 会话引用缓存：跨组件卸载/重挂**复用同一个会话引用**，grace 期内不重复 retain。
		*
		* ## 为什么需要（2026-11-03 问题 2 根因链，已核实）
		*
		* 插件原实现每次 effect 卸载都 `reference.release()` ⇒ 宿主
		* `ClientSessions.retireScope`（`session-controller/src/client/sessions/service.ts:586-595`）
		* 直接 `manager.drop` + `session.dispose()`（`manager.ts:191-198` / `session.ts:599-611`），
		* **整个 Session 实例与已加载的事件窗口（转录）一起被销毁**。面板卸载/重挂（切走主面板
		* 再回来）后只能重新 retain ⇒ 新建 Session ⇒ `doOpen` 重新拉整段历史（`session.ts:616-643`）。
		* 会话越大这段重拉越慢；一旦 `doOpen`/follow 失败，`openState='error'`、`openError` 置位
		* （`session.ts:634-639`、`876-886`），转录**永久为空**且原布局把输入框顶到转录区顶部
		* ——即用户看到的「第二次进入后看不见对话内容、对话框到顶端」。
		*
		* 本缓存让「切走再回来」直接复用还活着的引用（同一 Session 实例、同一份已加载转录），
		* 不触发重拉；真正无用后延迟 {@link REF_RELEASE_GRACE_MS} 再释放，避免长期占用宿主会话。
		*
		* ## 安全约束
		*
		* - `markStale` **不立刻 release**：点击“重新打开”时旧引用仍被 SessionProvider 渲染着，
		*   立即 release 会让下一次渲染在 `SessionReference.binding` 上抛
		*   “is released”（`service.ts:196-199`）进而摘除面板条目。真正的释放发生在
		*   下一次 {@link acquire} 换新时（effect 体内、setState 之前，React 不会在其间插入渲染）。
		* - 同一键可被多个持有者共享（用户数计数）；只有最后一个持有者离开才进入 grace 倒计时。
		*/
		var SessionRefCache = class {
			entries = /* @__PURE__ */ new Map();
			/**
			* 取一个引用：命中且非陈旧则复用（取消待释放），否则经 factory 新建。
			*
			* @param key - 会话键（子会话 id）。
			* @param factory - 未命中时的持有动作（retain）。抛错向上冒泡，由调用方如实展示。
			* @returns 可用引用。
			*/
			acquire(key, factory) {
				const entry = this.entries.get(key);
				if (entry !== void 0 && !entry.stale) {
					if (entry.timer !== void 0) {
						clearTimeout(entry.timer);
						entry.timer = void 0;
					}
					entry.users += 1;
					return entry.reference;
				}
				if (entry !== void 0) this.drop(key, entry);
				const reference = factory();
				this.entries.set(key, {
					reference,
					users: 1,
					timer: void 0,
					stale: false
				});
				return reference;
			}
			/**
			* 归还一次持有。最后一个持有者离开后延迟释放（grace 期内可被 {@link acquire} 救回）。
			*
			* @param key - 会话键。
			*/
			release(key) {
				const entry = this.entries.get(key);
				if (entry === void 0) return;
				entry.users -= 1;
				if (entry.users > 0) return;
				if (entry.stale) {
					this.drop(key, entry);
					return;
				}
				if (entry.timer !== void 0) clearTimeout(entry.timer);
				entry.timer = setTimeout(() => {
					const current = this.entries.get(key);
					if (current !== entry || current.users > 0) return;
					this.drop(key, current);
				}, REF_RELEASE_GRACE_MS);
			}
			/**
			* 标记陈旧（「重新打开会话」用）：不立刻释放，下一次 {@link acquire} 换新时释放。
			*
			* @param key - 会话键。
			*/
			markStale(key) {
				const entry = this.entries.get(key);
				if (entry === void 0) return;
				entry.stale = true;
				if (entry.users <= 0) this.drop(key, entry);
				else if (entry.timer !== void 0) {
					clearTimeout(entry.timer);
					entry.timer = void 0;
				}
			}
			/** 当前缓存项数（测试/诊断用）。 */
			get size() {
				return this.entries.size;
			}
			/** 某键是否在缓存中（测试/诊断用）。 */
			has(key) {
				return this.entries.has(key);
			}
			drop(key, entry) {
				if (entry.timer !== void 0) {
					clearTimeout(entry.timer);
					entry.timer = void 0;
				}
				if (this.entries.get(key) === entry) this.entries.delete(key);
				try {
					entry.reference.release();
				} catch {}
			}
		};
		/**
		* 最后一个持有者离开后，引用再保留多久才真正 release（毫秒）。
		*
		* 覆盖「切到别的主面板再回来」「在任务 Tab 间来回切」这类秒级~分钟级往返：
		* grace 内回来零成本复用转录；超时后照常释放，不长期占用宿主会话。
		*/
		const REF_RELEASE_GRACE_MS = 3e5;
		/**
		* 「重新打开会话」的刷新刻度。
		*
		* 会话体（子槽组件）能读到 `openState='error'`，但**换引用的动作在对话框 effect 里**
		* （只有它持有 retain 生命周期）。两边隔着槽位边界，经此极小 store 传一个递增刻度：
		* 会话体 `markStale` + `bump()` ⇒ 对话框 effect 依赖变化 ⇒ 重新 acquire（换新引用）。
		*/
		var RefreshTickStore = class {
			tick = 0;
			listeners = /* @__PURE__ */ new Set();
			/** 当前刻度。 */
			getSnapshot() {
				return this.tick;
			}
			/** 刻度 +1 并通知订阅者。 */
			bump() {
				this.tick += 1;
				for (const fn of [...this.listeners]) fn();
			}
			/** 订阅刻度变化。 */
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
		};
		//#endregion
		//#region src/client/components/OrchestratorChat.tsx
		/** 空模型（未选择任何需求）。 */
		const EMPTY_CHAT_MODEL = {
			visible: false,
			requirementKey: "",
			requirementTitle: "",
			items: [],
			activeKey: ""
		};
		/**
		* 模块级可见 store。
		*
		* 为什么不用 props 穿透：对话框由**父槽位条目**（工作台）渲染，而"当前焦点需求 / 选中会话"
		* 是**任务中心组件内部**的状态（它才有看板快照与焦点需求）。二者之间隔着槽位边界，
		* props 传不过去；用一个极小的 store 让两边解耦，比把任务中心的全部状态上提到工作台更干净
		* （上提会让工作台重新渲染整棵面板树）。
		*/
		var ChatPanelStore = class {
			model = EMPTY_CHAT_MODEL;
			listeners = /* @__PURE__ */ new Set();
			get() {
				return this.model;
			}
			set(next) {
				this.model = next;
				for (const fn of [...this.listeners]) fn();
			}
			/**
			* 只改选中项（切换条点击用）。
			*
			* 选中项由 store 单向持有，任务中心发布新快照时**不再**覆盖它——否则看板每 3 秒
			* 轮询一次就会把用户刚点的子会话弹回「主 agent」。
			*/
			selectKey(key) {
				if (this.model.activeKey === key) return;
				this.model = {
					...this.model,
					activeKey: key
				};
				for (const fn of [...this.listeners]) fn();
			}
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
		};
		/** 全局单例（一个前端只有一块任务中心）。 */
		const chatPanelStore = new ChatPanelStore();
		/**
		* 子会话「父会话是否在线」的运行时状态。
		*
		* ## 为什么单独一个 store（而不是塞进 ChatPanelModel）
		*
		* `ChatPanelModel` 由**任务中心**写入（它才有看板快照），而"父会话在不在"只有**会话体内**的
		* `useSession` 知道（`session.subagent.parentAvailable`，宿主在 catalog 解析后才填）。
		* 两者是**不同的数据源、不同的写入时刻**，硬合并会让任一侧都要等另一侧刷新。
		*
		* ## 口径必须与宿主输入栏逐字一致
		*
		* `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:133-134`：
		* `continuable = address.mode === 'continuable'`；`parentOffline = continuable && parentAvailable !== true`。
		* `parentAvailable` 的语义是"**直到 catalog 解析前都缺席**"（`snapshot.ts:77` 注释），
		* 所以 `!== true` 把"还不知道"也算作离线 —— 此处照抄同一判定，
		* 否则会出现"输入框已禁写、面板却说在线"的自相矛盾。
		*/
		var ParentStatusStore = class {
			state = {
				childSessionId: "",
				parentOffline: false
			};
			listeners = /* @__PURE__ */ new Set();
			get() {
				return this.state;
			}
			set(next) {
				if (this.state.childSessionId === next.childSessionId && this.state.parentOffline === next.parentOffline) return;
				this.state = next;
				for (const fn of [...this.listeners]) fn();
			}
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
		};
		/** 子会话父在线状态单例。 */
		const parentStatusStore = new ParentStatusStore();
		/**
		* 会话引用缓存（跨面板卸载/重挂复用同一引用，修「第二次进入对话框无内容」）。
		*
		* 机制与安全约束见 {@link SessionRefCache} 文档：原实现每次卸载都 release，
		* 宿主随即销毁 Session 实例与已加载转录，回来只能整段重拉历史（大转录慢/失败即空白）。
		*/
		const sessionRefCache = new SessionRefCache();
		/**
		* 「重新打开会话」刷新刻度（会话体 ↔ 对话框 effect 之间的极小通道）。
		* 会话体检测到 `openState='error'` 后 `markStale` + `bump()`，对话框 effect 换新引用。
		*/
		const sessionRefreshStore = new RefreshTickStore();
		/** React 侧订阅（与 {@link useChatModel} 同款手写订阅，理由见该函数注释）。 */
		function useParentStatus() {
			const [state, setState] = (0, react.useState)(() => parentStatusStore.get());
			(0, react.useEffect)(() => {
				const un = parentStatusStore.subscribe(() => setState(parentStatusStore.get()));
				setState(parentStatusStore.get());
				return un;
			}, []);
			return state;
		}
		/** React 侧订阅（React 18 的 useSyncExternalStore 在插件冻结模块表里可用性不确定，故手写）。 */
		function useChatModel() {
			const [model, setModel] = (0, react.useState)(() => chatPanelStore.get());
			(0, react.useEffect)(() => {
				const un = chatPanelStore.subscribe(() => setModel(chatPanelStore.get()));
				setModel(chatPanelStore.get());
				return un;
			}, []);
			return model;
		}
		/** 订阅「重新打开会话」刷新刻度（手写订阅，理由见 {@link useChatModel}）。 */
		function useSessionRefreshTick() {
			const [tick, setTick] = (0, react.useState)(() => sessionRefreshStore.getSnapshot());
			(0, react.useEffect)(() => {
				const un = sessionRefreshStore.subscribe(() => setTick(sessionRefreshStore.getSnapshot()));
				setTick(sessionRefreshStore.getSnapshot());
				return un;
			}, []);
			return tick;
		}
		/**
		* retain/release 一个子会话引用（AC1.4），经 {@link sessionRefCache} 复用。
		*
		* 纪律：
		*   - `ctx.sessions` **调用时**解析（不能闭包捕获，见项目纪律 6）；
		*   - 真正的 retain 只发生在缓存未命中时；卸载/切目标只做 `release` 归还，
		*     grace 期内再次进入**直接复用同一引用**（同一 Session 实例、同一份已加载转录），
		*     不再触发宿主整段重拉历史（问题 2 根因链，见 {@link SessionRefCache} 文档）；
		*   - retain 抛错（会话不存在 / 服务缺失）⇒ 返回 `{ error }`，由 UI 如实展示。
		*/
		function useSessionReference(ctx, target, enabled) {
			const [state, setState] = (0, react.useState)({ reference: null });
			const childId = target?.childSessionId ?? "";
			const parentId = target?.parentSessionId ?? "";
			const refreshTick = useSessionRefreshTick();
			(0, react.useEffect)(() => {
				if (!enabled || !childId) {
					setState({ reference: null });
					return;
				}
				const sessions = ctx.get("sessions", false);
				if (!sessions || typeof sessions.retain !== "function") {
					setState({
						reference: null,
						error: "宿主未提供 sessions 服务，无法内嵌会话（可在侧边栏打开）"
					});
					return;
				}
				const svc = sessions;
				try {
					const reference = sessionRefCache.acquire(childId, () => {
						const targetRef = parentId ? {
							parentSessionId: parentId,
							childSessionId: childId,
							mode: target?.mode ?? "unknown"
						} : childId;
						const acquired = svc.retain(targetRef, { source: "tfsOrchestratorChat" }) ?? null;
						if (acquired === null) throw new Error("宿主 sessions.retain 未返回会话引用");
						return acquired;
					});
					setState({ reference });
				} catch (e) {
					setState({
						reference: null,
						error: `会话不可读：${e instanceof Error ? e.message : String(e)}`
					});
					return;
				}
				return () => {
					sessionRefCache.release(childId);
				};
			}, [
				ctx,
				childId,
				parentId,
				enabled,
				target?.mode,
				refreshTick
			]);
			return state;
		}
		/**
		* 子槽组件：把绑定好的会话渲染成**宿主自己的会话正文**（US1 / AC1.3）。
		*
		* 与官方侧边对话的 `ConversationSlotPanel` 同构
		* （`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:121-148`）：
		* 用工厂渲染 `conversation.content`，并把 `views` 位置固定为 `chat`。
		*/
		function OrchestratorChatBody(props) {
			const renderFactorySlot = props["renderFactorySlot"];
			const useSession = props["useSession"];
			const useConversation = props["useConversation"];
			/** 会话列表行 blank 标志（官方相位公式要用；`useSessions` 是框架标准注入）。 */
			const useSessions = props["useSessions"];
			const sessionId = props["sessionId"];
			const session = useSession?.((v) => v) ?? {};
			const conversation = useConversation?.((v) => v) ?? {};
			const sessionsList = useSessions?.((v) => v) ?? {};
			const summaryBlank = sessionId === void 0 ? void 0 : sessionsList.byId?.[sessionId]?.blank;
			/**
			* 把「父会话是否在线」发布给对话框 chrome（父离线提示 + 回主会话入口要用）。
			*
			* 只有**这个位置**知道答案：`subagent.parentAvailable` 由宿主在 catalog 解析后才填
			* （`session-controller/.../snapshot.ts:77`），且会话体外拿不到。
			* 判定口径逐字照抄宿主输入栏（`InputBar.tsx:133-134`），见 {@link ParentStatusStore} 注释。
			*/
			const sub = session.subagent;
			const parentOffline = sub?.address?.mode === "continuable" && sub?.parentAvailable !== true;
			(0, react.useEffect)(() => {
				parentStatusStore.set({
					childSessionId: sub?.address?.childSessionId ?? "",
					parentOffline
				});
				return () => parentStatusStore.set({
					childSessionId: "",
					parentOffline: false
				});
			}, [sub?.address?.childSessionId, parentOffline]);
			/**
			* 相位：**逐字对齐官方 `ConversationSlotPanel`**（`shared/chat-panel.ts#computeChatPhase`）。
			*
			* 此前自拟口径缺 `settling`：会话重挂后历史窗口还在 loading 时被画成 `active`
			* ⇒ 转录区空白、输入框浮到转录区顶部（2026-11-03 用户截图）。官方此时是
			* `settling`（composer 隐藏、无错误布局），加载完成后自然落回 `active` 出内容。
			*/
			const { phase, hero } = computeChatPhase({
				activeTargetsSize: conversation.activeTargets?.size ?? 0,
				session,
				summaryBlank
			});
			/** 「重新打开会话」：标记陈旧 + 通知对话框 effect 换新引用（不在这里直接 release，见缓存文档）。 */
			const retryOpen = (0, react.useCallback)(() => {
				const child = sub?.address?.childSessionId;
				if (child) sessionRefCache.markStale(child);
				sessionRefreshStore.bump();
			}, [sub?.address?.childSessionId]);
			if (typeof renderFactorySlot !== "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
				title: "当前宿主不支持内嵌会话渲染",
				detail: "缺少 renderFactorySlot（宿主版本较旧）。可点右上角「在侧边栏打开」查看会话。"
			});
			/**
			* 历史窗口打开/跟随失败（`SessionSnapshot.openState==='error'`）的可读降级。
			*
			* 不替换会话体（半程失败时已有部分转录可看），只在其上方挂横幅 + 重开入口 ——
			* 与项目纪律「绝不白屏、绝不假装可用」一致：说清失败原因并给出可执行动作。
			*/
			const openErrorBanner = session.openState === "error" ? (() => {
				const raw = session.openError;
				const reason = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof raw.message === "string" ? raw.message : "未知原因";
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					"data-tfs-chat-open-error": "",
					style: {
						padding: "7px 10px",
						fontSize: 11,
						lineHeight: 1.6,
						color: "#991b1b",
						background: "#fef2f2",
						borderBottom: "1px solid #fecaca"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontWeight: 600,
								marginBottom: 2
							},
							children: "会话历史加载失败，下方可能只有部分记录。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { color: "#b91c1c" },
							children: ["原因：", reason]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...buttonStyle$2,
								marginTop: 6,
								borderColor: "#fca5a5",
								background: "#fff"
							},
							onClick: retryOpen,
							children: "重新打开会话"
						})
					]
				});
			})() : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					flex: 1,
					minHeight: 0,
					display: "flex",
					flexDirection: "column"
				},
				children: [openErrorBanner, renderFactorySlot("conversation.content", {
					variant: "embedded",
					phase,
					hero
				}, { slots: { views: FixedChatView } })]
			});
		}
		/** 固定为 `chat` 视图的会话正文（与官方 `FixedChatConversationView` 同义）。 */
		function FixedChatView(props) {
			const renderSlot = props["renderSlot"];
			if (typeof renderSlot !== "function") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: renderSlot("conversation.session", { view: "chat" }) });
		}
		/** 可读的降级提示（不白屏、不假装可用）。 */
		function FallbackNotice(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					flex: 1,
					display: "flex",
					flexDirection: "column",
					gap: 8,
					alignItems: "center",
					justifyContent: "center",
					padding: 24,
					textAlign: "center",
					color: "#6b7280",
					fontSize: 12
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 600,
							color: "#374151"
						},
						children: props.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							lineHeight: 1.6,
							maxWidth: 420
						},
						children: props.detail
					}),
					props.action
				]
			});
		}
		const buttonStyle$2 = {
			padding: "4px 9px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f9fafb",
			cursor: "pointer",
			fontSize: 12
		};
		/**
		* 父会话离线提示条（#3 的正解：把"为什么不能打字"讲清楚，并给出唯一可行的下一步）。
		*
		* ## 为什么面板必须自己讲这件事
		*
		* 宿主输入栏的占位符只说"父会话已离线，无法继续发送"，但**没说该去哪、为什么**。
		* 真实原因（已核实）：编排主 agent 是**用户主会话的 continuable 子会话**
		* （`orchestrator-session.ts:384` 取 `parent.session.id`），而本面板是**独立 Client Session**，
		* 它的 session 列表里根本没有主会话那条记录 ⇒ `agentAvailable(parent)` 恒为 false
		* （`session-controller/.../manager.ts:378-380`）⇒ 宿主按"子随父活"冻结输入。
		* 这是**正常保护**（父不在时禁止子空转），不是故障。
		*
		* ## 面板里仍然可以做什么（必须如实告知，别让用户以为全坏了）
		*
		* - 看完整会话记录与归纳/总结产物（只读，随时可看）；
		* - 停止正在运行的这一轮（continuable 的 Stop 独立保留，见 `InputBar.tsx:460-475`）；
		* - 切到别的任务子会话；
		* - 任务的**自动归纳与最终总结照常运行** —— 它们走宿主侧真实 live Agent
		*   （`orchestrator-session.ts:454-459`/`512-515`），与本面板视图无关。
		*/
		function ParentOfflineNotice(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-tfs-parent-offline": "",
				style: {
					padding: "7px 10px",
					fontSize: 11,
					lineHeight: 1.6,
					color: "#92400e",
					background: "#fffbeb",
					borderBottom: "1px solid #fde68a"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 600,
							marginBottom: 2
						},
						children: "这是「主会话」的子会话 —— 主会话不在当前视图里，所以暂时不能在这里直接发消息。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { color: "#a16207" },
						children: [
							"主会话恢复后即可继续对话；期间可自由查看记录、停止本轮、切换其它任务。 任务的自动归纳与最终总结由宿主在后台继续执行，",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "不受影响" }),
							"。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 6,
							marginTop: 6,
							flexWrap: "wrap"
						},
						children: [props.onOpenParent && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...buttonStyle$2,
								borderColor: "#fcd34d",
								background: "#fff"
							},
							onClick: props.onOpenParent,
							children: "回到主会话继续"
						}), props.onOpenAside && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle$2,
							onClick: props.onOpenAside,
							title: "在侧边栏查看这个子会话（仍为只读，父会话在线后才能输入）",
							children: "在侧边栏查看"
						})]
					})
				]
			});
		}
		/**
		* 任务中心右侧「主对话框」（US1/US4）。
		*
		* 组成：切换条（主 agent + 各任务子会话）+ 会话体（父条目注入的 SessionProvider 内嵌真实会话）
		*      + 「在侧边栏打开」兜底 + 降级提示。
		*
		* @param props.kit - 父条目（工作台）透传下来的槽位能力（SessionProvider / renderSlot）。
		* @param props.ctx - 客户端 cordis 上下文（**调用时**解析 sessions / sidebarRight）。
		* @param props.onEnsureOrchestrator - 「创建编排会话」按钮回调（走宿主路由）。
		* @param props.onClose - 收起对话框。
		*/
		function OrchestratorChatDock(props) {
			const model = useChatModel();
			const active = model.items.find((i) => i.key === model.activeKey);
			const target = active?.enabled ? active.target ?? null : null;
			const { reference, error } = useSessionReference(props.ctx, target, model.visible);
			const [busy, setBusy] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)("");
			/** 问题 6：需求未配置工作目录时的补填输入（创建编排会话的前置条件）。 */
			const [wsInput, setWsInput] = (0, react.useState)("");
			const parentStatus = useParentStatus();
			/**
			* 「回到主会话继续对话」（父会话离线时的唯一出路）。
			*
			* 为什么必须走宿主导航而不是自己拼界面：continuable 子会话的输入权限**由宿主按
			* "父是否在线"裁决**（`InputBar.tsx:133-139` 的 `parentOffline ⇒ disabled`），
			* 插件侧任何绕过都只是假输入框，消息根本进不了宿主的 inbox。
			* `uiWorkspace.openSession(parentSessionId)` 会 `replaceMain(…, 'reveal')`
			* ⇒ 主会话被选中**且面板被显示**，用户落到真正能打字的地方。
			*
			* @returns 是否成功导航（服务缺失/抛错 ⇒ false，由调用方如实告知）。
			*/
			const openParentSession = (0, react.useCallback)((t) => {
				if (!t || !t.parentSessionId) return false;
				const nav = props.ctx.get("uiWorkspace", false);
				if (!nav || typeof nav.openSession !== "function") return false;
				try {
					nav.openSession(t.parentSessionId);
					return true;
				} catch {
					return false;
				}
			}, [props.ctx]);
			const openAside = (0, react.useCallback)((t) => {
				if (!t) return false;
				const sidebar = props.ctx.get("sidebarRight", false);
				if (!sidebar || typeof sidebar.openResource !== "function") return false;
				const address = buildChatAddress(t);
				if (!address) return false;
				try {
					sidebar.openResource(address, {
						kind: "subagentchat",
						preferNewPane: true
					});
					return true;
				} catch {
					return false;
				}
			}, [props.ctx]);
			if (!model.visible) return null;
			const canUseInline = Boolean(props.kit.SessionProvider && props.kit.renderSlot);
			const asideAvailable = (() => {
				const sidebar = props.ctx.get("sidebarRight", false);
				return Boolean(sidebar && typeof sidebar.openResource === "function");
			})();
			const body = (() => {
				if (!model.requirementKey) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
					title: "未选择需求",
					detail: "在上方需求列表里点一行，右侧就会显示该需求的编排主 agent 会话。"
				});
				if (!model.orchestrator || model.orchestrator.mode !== "continuable") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
					title: "尚未创建编排主 agent",
					detail: model.orchestrator?.reason ?? "该需求还没有可对话的编排会话。创建后，任务完成后会自动归纳结论、全部完成时出最终总结并回写 TFS。",
					action: props.onEnsureOrchestrator ? (() => {
						const hasWs = Boolean((model.requirementWorkspace ?? "").trim());
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 6,
								alignItems: "flex-start"
							},
							children: [!hasWs && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#b45309"
								},
								children: "创建编排会话前需先设置工作目录（简报与子 agent 代码库定位都依赖它）："
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: {
									padding: "6px 8px",
									borderRadius: 6,
									border: "1px solid #d1d5db",
									fontSize: 13,
									minWidth: 240
								},
								placeholder: "绝对路径，如 D:\\\\code\\\\his",
								value: wsInput,
								onChange: (e) => setWsInput(e.target.value)
							})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$2,
								disabled: busy,
								onClick: () => {
									const ws = wsInput.trim() || (model.requirementWorkspace ?? "").trim();
									if (!ws) {
										setNotice("请先填写工作目录，再创建编排会话");
										return;
									}
									setBusy(true);
									setNotice("");
									props.onEnsureOrchestrator(model.requirementKey, { workspace: ws }).then((r) => setNotice(r.ok ? "编排会话已创建" : `创建失败：${r.reason ?? "未知原因"}`)).finally(() => setBusy(false));
								},
								children: busy ? "创建中…" : "创建编排会话"
							})]
						});
					})() : void 0
				});
				if (!canUseInline) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
					title: "当前宿主不支持内嵌会话",
					detail: "宿主未注入 SessionProvider/renderSlot（版本较旧）。仍可用下方的「在侧边栏打开」查看会话。"
				});
				if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
					title: "会话不可读",
					detail: error,
					action: asideAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$2,
						onClick: () => openAside(target),
						children: "在侧边栏打开"
					}) : void 0
				});
				if (!target) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
					title: "该任务还没有会话",
					detail: "任务派发成功后，这里可以切到它的子 agent 会话。"
				});
				if (!reference) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackNotice, {
					title: "正在打开会话…",
					detail: "正在向宿主申请会话引用。"
				});
				/**
				* ⚠️ **必须用 JSX 渲染 `SessionProvider`，不能当普通函数调用**（2026-10-01 白屏根因）。
				*
				* 宿主注入的 `SessionProvider` 是**真组件**：内部调用 `useScopeBinding()` 与
				* `useSyncExternalStore(...)`
				* （`ui-renderer/src/client/scoped-slots.tsx:510-518`）。写成
				* `kit.SessionProvider({ session, children })` 会把这两个 hook **内联进本组件的 hook 序列**，
				* 而它又在 `body()` 的条件分支里 —— `reference` 由 null 变成有值那一次渲染，
				* hook 数量发生变化 ⇒ React 抛 "Rendered more hooks than during the previous render"
				* ⇒ 整个面板条目崩溃被宿主摘除 ⇒ **白屏**。
				*
				* 官方侧边对话用的就是 JSX（同文件 `:163`），这里必须同形。
				*/
				const SessionProvider = props.kit.SessionProvider;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionProvider, {
					session: reference,
					children: props.kit.renderSlot(props.kit.childKey, {})
				}), active?.key !== "orchestrator" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: "6px 10px",
						borderTop: "1px solid #f1f5f9",
						display: "flex",
						gap: 8
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$2,
						onClick: () => chatPanelStore.selectKey("orchestrator"),
						children: "← 返回主 agent"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: 11,
							color: "#9ca3af",
							alignSelf: "center"
						},
						children: "ONE-SHOT 子会话结束后不可继续输入；需要补充指令请用任务详情里的「追问」。"
					})]
				})] });
			})();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-tfs-orchestrator-chat": "",
				style: {
					width: 420,
					minWidth: 280,
					maxWidth: "60%",
					minHeight: 0,
					display: "flex",
					flexDirection: "column",
					border: "1px solid #e5e7eb",
					borderRadius: 8,
					background: "#fff",
					overflow: "hidden"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							padding: "8px 10px",
							borderBottom: "1px solid #f1f5f9",
							background: "#fafafa"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: { fontSize: 13 },
								children: "主对话框"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: "#9ca3af",
									flex: 1,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								},
								children: model.requirementTitle || "未选择需求"
							}),
							asideAvailable && active?.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$2,
								onClick: () => openAside(target),
								title: "用宿主的侧边对话打开当前会话",
								children: "在侧边栏打开"
							}),
							props.onClose && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$2,
								onClick: props.onClose,
								title: "收起对话框",
								children: "收起"
							})
						]
					}),
					model.items.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexWrap: "wrap",
							gap: 6,
							padding: "8px 10px",
							borderBottom: "1px solid #f1f5f9"
						},
						children: model.items.map((item) => {
							const isActive = item.key === model.activeKey;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								disabled: !item.enabled,
								title: item.enabled ? item.label : item.reason ?? "该任务还没有会话",
								onClick: () => chatPanelStore.selectKey(item.key),
								style: {
									...buttonStyle$2,
									cursor: item.enabled ? "pointer" : "not-allowed",
									opacity: item.enabled ? 1 : .5,
									borderColor: isActive ? "#93c5fd" : "#d1d5db",
									background: isActive ? "#eff6ff" : "#f9fafb",
									display: "inline-flex",
									alignItems: "center",
									gap: 6,
									maxWidth: 200
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									},
									children: item.label
								}), item.badge && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 10,
										color: item.badge.color,
										background: item.badge.bg,
										borderRadius: 8,
										padding: "0 5px"
									},
									children: item.badge.text
								})]
							}, item.key);
						})
					}),
					notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "6px 10px",
							fontSize: 11,
							color: "#92400e",
							background: "#fffbeb"
						},
						children: notice
					}),
					active?.key === "orchestrator" && parentStatus.parentOffline && parentStatus.childSessionId !== "" && parentStatus.childSessionId === target?.childSessionId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ParentOfflineNotice, {
						onOpenParent: target?.parentSessionId ? () => {
							openParentSession(target);
						} : void 0,
						onOpenAside: asideAvailable ? () => {
							openAside(target);
						} : void 0
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							flex: 1,
							minHeight: 0,
							display: "flex",
							flexDirection: "column"
						},
						children: body
					})
				]
			});
		}
		//#endregion
		//#region src/shared/requirement-status.ts
		/** 需求是否已完成（缺省 = 进行中；历史 `board.json` 没有该字段）。 */
		function isRequirementCompleted(r) {
			return r.execState === "completed";
		}
		/**
		* 把需求集合拆成「任务中心（进行中）」与「已完成」两页（问题 3）。
		*
		* 保持**输入顺序**（不做排序）：列表顺序由上游决定，派生层擅自重排会让"我刚领取的需求
		* 跑到第 5 行"这种预期外的跳动出现。
		*
		* @param requirements - 全部已领取需求（看板快照）。
		*/
		function splitRequirementsByExecState(requirements) {
			const active = [];
			const completed = [];
			for (const r of requirements) if (isRequirementCompleted(r)) completed.push(r);
			else active.push(r);
			return {
				active,
				completed
			};
		}
		/**
		* 已完成页检索（问题 2：按**需求 ID** 与**需求标题**检索）。
		*
		* ID 用 `includes` 而非严格相等：用户常记得"最后四位"而不是完整号。
		* 关键字为空/全空白时返回原集合的**浅拷贝**（调用方通常直接当列表渲染，避免共享引用）。
		*
		* @param items - 已完成需求。
		* @param keyword - 检索词（空 = 不过滤）。
		*/
		function filterCompletedRequirements(items, keyword) {
			const kw = keyword.trim().toLowerCase();
			if (kw.length === 0) return [...items];
			return items.filter((r) => String(r.id).includes(kw) || r.title.toLowerCase().includes(kw));
		}
		/** ISO 时刻 → 本地 `HH:mm`（定时待执行文案用；非法时刻回退原串）。 */
		function formatDueMinute(iso) {
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return iso;
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}
		/**
		* 派生某需求的执行状态（问题 4；2026-11-03 问题 3 增「定时待执行」）。
		*
		* 判定顺序即优先级：已完成（需求级）> 未拆解 > 定时待执行 > 执行中 > 有失败 > 待办 > 已完成 c/t。
		* 这个顺序是有意的：**"正在跑"比"有失败"更需要被看到**（失败任务可能已经有人在处理），
		* 而"有失败"又比"还有待办"更需要被看到（用户需要知道有东西卡住了）。
		*
		* 「定时待执行」只替换**无任务**时的「未拆解」：定时登记此刻不建任务（到点才派发），
		* 界面若仍显示「未拆解」会误导用户"定时没生效"（2026-11-03 实机反馈）。
		* 名下已有任务时（如 chain 定时编排已有拆解任务）仍按任务集合派生，定时信息在
		* 任务中心「定时执行」区展示。
		*
		* @param r - 需求（只看 `execState`）。
		* @param ownTasks - 该需求名下的全部任务（含已取消）。
		* @param scheduledDueAt - 该需求挂起的定时条目到点时刻（ISO 8601；无 = 不参与派生）。
		*/
		function summarizeRequirementExec(r, ownTasks, scheduledDueAt) {
			if (isRequirementCompleted(r)) return {
				text: "已完成",
				tone: "done"
			};
			if (ownTasks.length === 0) {
				if (scheduledDueAt) return {
					text: `定时待执行 ${formatDueMinute(scheduledDueAt)}`,
					tone: "pending"
				};
				return {
					text: "未拆解",
					tone: "todo"
				};
			}
			const running = ownTasks.filter((t) => t.execState === "running").length;
			if (running > 0) return {
				text: `执行中 ${running}`,
				tone: "running"
			};
			const failed = ownTasks.filter((t) => t.execState === "failed").length;
			if (failed > 0) return {
				text: `有失败 ${failed}`,
				tone: "failed"
			};
			const deleted = ownTasks.filter((t) => t.state === "deleted").length;
			const open = ownTasks.filter((t) => t.state !== "completed" && t.state !== "deleted").length;
			if (open > 0) return {
				text: `待办 ${open}`,
				tone: "pending"
			};
			const completed = ownTasks.filter((t) => t.state === "completed").length;
			if (completed === 0) return {
				text: "已全部取消",
				tone: "todo"
			};
			return {
				text: `已完成 ${completed}/${ownTasks.length - deleted}`,
				tone: "done"
			};
		}
		//#endregion
		//#region src/client/components/TaskCenter.tsx
		const sectionStyle$1 = {
			border: "1px solid #e5e7eb",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12,
			background: "#fff"
		};
		const inputStyle$1 = {
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		const buttonStyle$1 = {
			padding: "4px 9px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f9fafb",
			cursor: "pointer",
			fontSize: 12
		};
		const dangerButtonStyle = {
			...buttonStyle$1,
			background: "#fef2f2",
			borderColor: "#fca5a5",
			color: "#b91c1c"
		};
		const cellStyle = {
			padding: "6px 8px",
			borderBottom: "1px solid #f1f5f9",
			fontSize: 12
		};
		const DEFAULT_CLAIMED_PAGE_SIZE = 10;
		const DEFAULT_TASK_PAGE_SIZE = 20;
		/** 已完成页「已完成需求」每页条数（问题 2；默认 10，档位复用 CLAIMED_PAGE_SIZE_OPTIONS）。 */
		const DEFAULT_DONE_PAGE_SIZE = 10;
		/**
		* 定时条目轮询间隔（2026-11-04）。
		*
		* 定时清单不写 board ⇒ 快照 `updatedAt` 变化驱动不了它，只能本页可见时主动问。
		* 10s 足够覆盖"在别的页签登记 / 到点触发后条目消失"，且比快照轮询（~3s）轻。
		*/
		const SCHEDULE_POLL_MS = 1e4;
		/** 看板四态配色。 */
		const STATE_STYLE = {
			pending: {
				color: "#b45309",
				bg: "#fef3c7",
				label: "待办"
			},
			in_progress: {
				color: "#1d4ed8",
				bg: "#dbeafe",
				label: "进行中"
			},
			/**
			* 2026-10-31：`state=in_progress` + `execState=failed` 时，"进行中"严重误导
			* （任务已经停了，只是保留 in_progress 供重试，S-07 设计）。
			* 渲染层在 execState=failed 时覆盖为"失败（可重试）"，语义与实际一致。
			*/
			_failed_override: {
				color: "#b91c1c",
				bg: "#fee2e2",
				label: "失败（可重试）"
			},
			completed: {
				color: "#047857",
				bg: "#d1fae5",
				label: "已完成"
			},
			deleted: {
				color: "#6b7280",
				bg: "#f3f4f6",
				label: "已取消"
			}
		};
		/** 执行链路态配色。 */
		const EXEC_STYLE = {
			queued: {
				color: "#b45309",
				label: "排队中"
			},
			running: {
				color: "#1d4ed8",
				label: "运行中"
			},
			needs_confirmation: {
				color: "#c2410c",
				label: "待人工确认"
			},
			success: {
				color: "#047857",
				label: "成功"
			},
			failed: {
				color: "#b91c1c",
				label: "失败"
			},
			cancelled: {
				color: "#6b7280",
				label: "已取消"
			}
		};
		/**
		* 需求级执行状态配色（问题 4）。
		*
		* 与 `shared/requirement-status.ts` 的 `tone` 一一对应：派生层只给语义，
		* 配色留在这里 —— 纯逻辑层不该知道"失败=红色"这类界面事实。
		*/
		/**
		* 需求完成回写报告的状态标签与配色。
		*
		* `running` 黄色（正在写）、`ok` 绿色、`partial` 橙色（部分失败，可重跑）、
		* `error` 红色（全部失败）。索引类型取自契约里的 `RequirementWriteBackReport.status`，
		* 因此宿主新增状态时会在这里编译报错，而不是悄悄落到"无标签"分支。
		*/
		const WRITEBACK_TONE = {
			running: {
				label: "进行中",
				color: "#92400e"
			},
			ok: {
				label: "已完成",
				color: "#047857"
			},
			partial: {
				label: "部分失败",
				color: "#b45309"
			},
			error: {
				label: "失败",
				color: "#b91c1c"
			}
		};
		const REQ_EXEC_STYLE = {
			done: {
				color: "#047857",
				bg: "#d1fae5"
			},
			running: {
				color: "#1d4ed8",
				bg: "#dbeafe"
			},
			failed: {
				color: "#b91c1c",
				bg: "#fee2e2"
			},
			pending: {
				color: "#b45309",
				bg: "#fef3c7"
			},
			todo: {
				color: "#6b7280",
				bg: "#f3f4f6"
			}
		};
		/** 状态药丸。 */
		function Pill(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					display: "inline-block",
					padding: "1px 7px",
					borderRadius: 10,
					fontSize: 11,
					color: props.color,
					background: props.bg,
					whiteSpace: "nowrap"
				},
				children: props.text
			});
		}
		/** 该任务当前可用的动作（按四态与执行态推导，非法动作不渲染，避免用户点了才报错）。 */
		function actionsFor(t) {
			if (t.state === "pending") return ["start", "cancel"];
			if (t.state === "in_progress") {
				if (t.execState === "needs_confirmation") return [
					"retry",
					"confirm",
					"fail",
					"cancel"
				];
				if (t.execState === "running") return [
					"complete",
					"fail",
					"cancel"
				];
				return [
					"retry",
					"complete",
					"fail",
					"cancel"
				];
			}
			if (t.state === "completed") return ["cancel"];
			return [];
		}
		const ACTION_LABEL = {
			start: "启动",
			retry: "重试",
			complete: "标记完成",
			fail: "标记失败",
			cancel: "取消",
			confirm: "确认通过"
		};
		/**
		* 动作文案（同一 action 在不同状态下语义不同，必须按状态区分）。
		*
		* `cancel` 对在办任务是"取消"，对已完成任务则是"撤销完成"——后者是把它退回 deleted
		* 以便需求能还原，混用"取消"会让人以为要丢掉已完成的产出。
		*
		* 2026-10-30：待人工确认时 `confirm` 与 `retry` 的语义必须一眼可分——
		* 「确认通过」只放行已有产出、**不会重新执行**；「重新执行」才开新一轮派发。
		* （现场事故：用户点了确认通过，以为会有第二轮执行，实际上没有任何派发发生。）
		*/
		function actionLabel(action, task) {
			if (action === "cancel" && task.state === "completed") return "撤销完成";
			if (task.execState === "needs_confirmation") {
				if (action === "retry") return "重新执行";
				if (action === "confirm") return "确认通过（放行产出，不重跑）";
			}
			return ACTION_LABEL[action];
		}
		/**
		* 任务是否可编辑（2026-10-29 诉求 2 修正）。
		*
		* 判据与宿主引擎**严格同源**：`Board.updateTask` 只拒绝 `deleted` 与 `execState==='running'`
		* （`core/board/board.ts:812-815`）。旧实现在 UI 侧另立一套更严的规则（只放 pending /
		* failed / needs_confirmation），于是**等待依赖（in_progress + queued）**与取消过的任务
		* 明明没在跑却看不到「编辑」按钮 —— 用户看到的正是"未执行的任务也不能切换模型/技能/MCP"。
		*
		* 现在：没在运行就能改（含排队中、待确认、失败），运行中一律隐藏入口（宿主也会拒）。
		*/
		function taskEditable(t) {
			if (t.state === "deleted" || t.state === "completed") return false;
			return t.execState !== "running";
		}
		/** 问题 5：从看板任务的 lastNote 中取出"待人工确认："后面的具体原因。 */
		function stripConfirmPrefix(note) {
			if (!note) return "";
			const m = note.match(/^待人工确认[：:]\s*([\s\S]*)$/);
			return m && m[1] ? m[1].trim() : note;
		}
		/**
		* 任务中心面板。
		* @param props.snapshot - 看板快照（null = 未加载/不可用）。
		* @param props.roles - 可指派角色（US5）。
		* @param props.collection - 当前集合（UI 状态命名空间；缺省用默认集合节点）。
		* @param props.onRefresh - 重新拉取快照（async；动作完成后 await，保证列表实时同步）。
		* @param props.onDecompose - 拆解需求为任务（T041，问题 9/10：返回 created/skipped/reason）。
		* @param props.onRestore - 还原需求回需求池（问题 7）。
		* @param props.onDeleteTasks - 删除已取消任务（问题 8，整批门禁）。
		* @param props.onAssign - 指派/改派任务角色（T042）。
		* @param props.onTaskState - 任务状态操作（T043）。
		*/
		function TaskCenter(props) {
			const [stateFilter, setStateFilter] = (0, react.useState)("");
			const [roleFilter, setRoleFilter] = (0, react.useState)("");
			const [requirementFilter, setRequirementFilter] = (0, react.useState)("");
			const [keyword, setKeyword] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const orchestrationBlocked = props.orchestration?.available === false;
			const [msg, setMsg] = (0, react.useState)(null);
			const [claimedPageSize, setClaimedPageSize] = (0, react.useState)(DEFAULT_CLAIMED_PAGE_SIZE);
			const [taskPageSize, setTaskPageSize] = (0, react.useState)(DEFAULT_TASK_PAGE_SIZE);
			/** 问题 8：勾选待删的已取消任务 id 集合。 */
			const [selectedDeleted, setSelectedDeleted] = (0, react.useState)(/* @__PURE__ */ new Set());
			/** 问题 5：勾选待派发的任务 id 集合。 */
			const [selectedTasks, setSelectedTasks] = (0, react.useState)(/* @__PURE__ */ new Set());
			/** 问题 3：正在编辑的已领取需求（null = 关闭）。 */
			const [reqEdit, setReqEdit] = (0, react.useState)(null);
			/** 2026-11-03 问题 2/5：拆解弹框（强校验工作目录 + 立刻/定时编排）。 */
			const [decomposeTarget, setDecomposeTarget] = (0, react.useState)(null);
			/** 问题 4：正在编辑的任务（null = 关闭）。 */
			const [taskEdit, setTaskEdit] = (0, react.useState)(null);
			/** spec 006：正在查看执行详情的任务 id（null = 关闭）；存 id 以便快照刷新后拿到最新任务对象。 */
			const [detailTaskId, setDetailTaskId] = (0, react.useState)(null);
			/** 问题 2：本页子 Tab（进行中 / 已完成）。 */
			const [viewTab, setViewTab] = (0, react.useState)("active");
			/** 问题 2：已完成页的需求检索词（对需求 ID 与标题）。 */
			const [doneKeyword, setDoneKeyword] = (0, react.useState)("");
			/** 问题 2：已完成需求列表每页条数（落盘记忆）。 */
			const [donePageSize, setDonePageSize] = (0, react.useState)(DEFAULT_DONE_PAGE_SIZE);
			/** 问题 2：已完成页当前焦点需求（null = 未选，回落为第一条）。 */
			const [focusKey, setFocusKey] = (0, react.useState)(null);
			/**
			* 主对话框焦点需求（2026-11-03 问题 1）：「已领取需求」行点选。
			*
			* 与「已完成」页的 `focusKey` 同构（行点击 + 焦点行标记），但落点是右侧主对话框。
			* '' = 未显式选，由 {@link resolveChatFocusKey} 回落到需求筛选 / 首条进行中需求。
			*/
			const [dialogFocusKey, setDialogFocusKey] = (0, react.useState)("");
			const hydratedRef = (0, react.useRef)(false);
			const loadUiStateRef = (0, react.useRef)(props.loadUiState);
			loadUiStateRef.current = props.loadUiState;
			const saveUiStateRef = (0, react.useRef)(props.saveUiState);
			saveUiStateRef.current = props.saveUiState;
			const uiKey = props.collection ?? "default";
			const snap = props.snapshot;
			const tasks = snap?.tasks ?? [];
			const requirements = snap?.requirements ?? [];
			const detailTask = detailTaskId ? tasks.find((t) => t.taskId === detailTaskId) ?? null : null;
			const { active: activeRequirements, completed: doneRequirementsAll } = (0, react.useMemo)(() => splitRequirementsByExecState(requirements), [requirements]);
			/** 已完成页经过检索过滤后的需求（问题 2）。 */
			const doneRequirements = (0, react.useMemo)(() => filterCompletedRequirements(doneRequirementsAll, doneKeyword), [doneRequirementsAll, doneKeyword]);
			/**
			* 已完成需求键集合。进行中 Tab 的**任务表**也按它过滤（问题 3）：需求迁走后其任务
			* 一并从"进行中"消失 —— 否则会出现"需求不见、任务还在"的半迁移状态。
			*/
			const doneReqKeys = (0, react.useMemo)(() => {
				const s = /* @__PURE__ */ new Set();
				for (const r of doneRequirementsAll) s.add(`${r.id}@${r.collection}`);
				return s;
			}, [doneRequirementsAll]);
			const activeTasks = (0, react.useMemo)(() => tasks.filter((t) => !doneReqKeys.has(t.requirementId)), [tasks, doneReqKeys]);
			const [scheduleEntries, setScheduleEntries] = (0, react.useState)([]);
			const [scheduleMsg, setScheduleMsg] = (0, react.useState)(null);
			/** 正在改时间的条目（null = 无）；dueAtLocal 为 datetime-local 控件值。 */
			const [scheduleEdit, setScheduleEdit] = (0, react.useState)(null);
			const onListSchedulesRef = (0, react.useRef)(props.onListSchedules);
			onListSchedulesRef.current = props.onListSchedules;
			const refreshSchedules = () => {
				const fn = onListSchedulesRef.current;
				if (!fn) return;
				fn().then((r) => {
					if (r.ok) setScheduleEntries(r.entries ?? []);
				}).catch(() => {});
			};
			/**
			* 本页可见性。页签保活 ⇒ 组件只挂载一次，**不能**只依赖挂载时的首拉：
			* 定时登记不写 board（快照 `updatedAt` 不变），"执行配置 → 定时执行"新登记的条目
			* 走不到下面那条 `snap.updatedAt` 依赖的刷新链（2026-11-04 根因）。
			*/
			const pageActive = props.active !== false;
			(0, react.useEffect)(() => {
				refreshSchedules();
			}, [snap?.updatedAt]);
			const wasActiveRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!pageActive) {
					wasActiveRef.current = false;
					return;
				}
				if (!wasActiveRef.current) {
					wasActiveRef.current = true;
					refreshSchedules();
				}
				const timer = setInterval(() => refreshSchedules(), SCHEDULE_POLL_MS);
				return () => clearInterval(timer);
			}, [pageActive]);
			/** 需求键 → 挂起定时条目的到点时刻（需求行派生用；同需求多条取最近一条）。 */
			const scheduleDueByRequirement = (0, react.useMemo)(() => {
				const m = /* @__PURE__ */ new Map();
				for (const e of scheduleEntries) {
					if (!e.requirementKey) continue;
					const prev = m.get(e.requirementKey);
					if (!prev || Date.parse(e.dueAt) < Date.parse(prev)) m.set(e.requirementKey, e.dueAt);
				}
				return m;
			}, [scheduleEntries]);
			/** ISO → `datetime-local` 控件值（本地时间、精确到分），用于改时间编辑器初值。 */
			const toDateTimeLocal = (iso) => {
				const d = new Date(iso);
				if (Number.isNaN(d.getTime())) return "";
				const p = (n) => String(n).padStart(2, "0");
				return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
			};
			const cancelScheduleEntry = async (id) => {
				if (!props.onCancelSchedule) return;
				setScheduleMsg(null);
				try {
					const r = await props.onCancelSchedule(id);
					if (r.ok) {
						setScheduleMsg({
							tone: "ok",
							text: "已取消该定时条目"
						});
						setScheduleEdit(null);
						setScheduleEntries((prev) => prev.filter((e) => e.id !== id));
					} else setScheduleMsg({
						tone: "err",
						text: r.reason ?? "取消失败"
					});
				} catch (e) {
					setScheduleMsg({
						tone: "err",
						text: e instanceof Error ? e.message : String(e)
					});
				} finally {
					refreshSchedules();
				}
			};
			const commitScheduleTime = async (id) => {
				if (!props.onUpdateSchedule || !scheduleEdit || scheduleEdit.id !== id) return;
				setScheduleMsg(null);
				const parsed = parseDateTimeLocal(scheduleEdit.dueAtLocal);
				if (!parsed.ok) {
					setScheduleMsg({
						tone: "err",
						text: parsed.reason
					});
					return;
				}
				try {
					const r = await props.onUpdateSchedule(id, parsed.plan.dueAt ?? "");
					if (r.ok) {
						const nextDueAt = r.scheduledAt ?? parsed.plan.dueAt ?? "";
						setScheduleMsg({
							tone: "ok",
							text: `已改到 ${formatLocalMinute(nextDueAt)}（本地时间）执行`
						});
						setScheduleEdit(null);
						setScheduleEntries((prev) => prev.map((e) => e.id === id ? {
							...e,
							dueAt: nextDueAt || e.dueAt
						} : e));
					} else setScheduleMsg({
						tone: "err",
						text: r.reason ?? "修改失败"
					});
				} catch (e) {
					setScheduleMsg({
						tone: "err",
						text: e instanceof Error ? e.message : String(e)
					});
				} finally {
					refreshSchedules();
				}
			};
			const activeRequirementKeys = (0, react.useMemo)(() => activeRequirements.map((r) => `${r.id}@${r.collection}`), [activeRequirements]);
			const chatFocusKey = (0, react.useMemo)(() => resolveChatFocusKey({
				explicitKey: dialogFocusKey,
				requirementFilter,
				activeRequirementKeys
			}), [
				dialogFocusKey,
				requirementFilter,
				activeRequirementKeys
			]);
			const chatFocusReq = (0, react.useMemo)(() => requirements.find((r) => `${r.id}@${r.collection}` === chatFocusKey), [requirements, chatFocusKey]);
			/**
			* 焦点需求变化时把切换条选中项回到「主 agent」。
			*
			* 选中项本身存在 `chatPanelStore` 里（切换条与对话框在槽位两侧，只能经 store 通信），
			* 本组件**不再**用自己的 state 复制一份：复制出来的副本只会被本组件自己写回
			* `'orchestrator'`，看板每 3 秒轮询一次就把用户刚点的子会话弹回去。
			*/
			(0, react.useEffect)(() => {
				chatPanelStore.selectKey("orchestrator");
			}, [chatFocusKey]);
			(0, react.useEffect)(() => {
				if (viewTab !== "active" || !chatFocusKey) {
					chatPanelStore.set({ ...EMPTY_CHAT_MODEL });
					return;
				}
				const orch = chatFocusReq?.orchestration;
				const parentSessionId = orch?.parentSessionId ?? "";
				const orchestratorSessionId = orch?.mode === "continuable" ? orch.orchestratorSessionId : void 0;
				const items = [{
					key: "orchestrator",
					label: "主 agent",
					enabled: Boolean(orchestratorSessionId && parentSessionId),
					...orchestratorSessionId && parentSessionId ? { target: {
						childSessionId: orchestratorSessionId,
						parentSessionId,
						mode: "continuable"
					} } : { reason: orch?.reason ?? "该需求尚未创建编排主 agent 会话" }
				}];
				for (const t of tasks.filter((t) => t.requirementId === chatFocusKey)) {
					const sessionId = t.orchestration?.sessionId ?? [...t.attempts].reverse().find((a) => a.runId)?.runId;
					const enabled = Boolean(sessionId && parentSessionId);
					const exec = EXEC_STYLE[t.execState];
					items.push({
						key: t.taskId,
						label: t.title || t.taskId,
						enabled,
						...enabled ? { target: {
							childSessionId: sessionId,
							parentSessionId,
							/**
							* 2026-11-04 修复「会话历史加载失败：subagent mode does not match the supplied
							* address（subagent/unauthorized）」。
							*
							* 旧实现按 `orchestration.reused` 猜模式（`reused ? 'continuable' : 'one-shot'`），
							* 但那个标志的含义是"**复用了已有子会话**"，与宿主描述符的 `mode` 毫无关系：
							* 一旦复用回退（宿主报 `belongs to another parent session`）就把 `reused` 置回 false，
							* 于是把一个 **continuable** 子会话标成 `one-shot`，宿主 `validateAddress`
							* （`dsh-api-session-controller/lib/index.js:1708`）直接拒绝读历史。
							*
							* 正确做法是不猜：宿主的契约里 `mode:'unknown'` 表示"调用方不知道，跳过校验"
							* （同处 `address.mode !== 'unknown' && …` 才报错）。真正的模式由宿主快照
							* `session.subagent.address.mode` 给出（见 `OrchestratorChat` 的 `continuable` 判定），
							* 不归我们推导。
							*/
							mode: "unknown"
						} } : { reason: "该任务还没有会话（尚未派发过，或宿主未回绑会话 id）" },
						...exec ? { badge: {
							text: exec.label,
							color: exec.color,
							bg: "#f3f4f6"
						} } : {}
					});
				}
				chatPanelStore.set({
					visible: true,
					requirementKey: chatFocusKey,
					requirementTitle: chatFocusReq?.title ?? chatFocusKey,
					...chatFocusReq?.workspace ? { requirementWorkspace: chatFocusReq.workspace } : {},
					...chatFocusReq?.prompt ? { requirementPrompt: chatFocusReq.prompt } : {},
					...orch ? { orchestrator: {
						mode: orch.mode === "continuable" ? "continuable" : "off",
						...orch.orchestratorSessionId ? { sessionId: orch.orchestratorSessionId } : {},
						...orch.parentSessionId ? { parentSessionId: orch.parentSessionId } : {},
						...orch.reason ? { reason: orch.reason } : {}
					} } : {},
					items,
					activeKey: items.some((i) => i.key === chatPanelStore.get().activeKey) ? chatPanelStore.get().activeKey : "orchestrator"
				});
			}, [
				viewTab,
				chatFocusKey,
				chatFocusReq,
				tasks
			]);
			(0, react.useEffect)(() => {
				let cancelled = false;
				hydratedRef.current = false;
				setClaimedPageSize(DEFAULT_CLAIMED_PAGE_SIZE);
				setTaskPageSize(DEFAULT_TASK_PAGE_SIZE);
				if (!loadUiStateRef.current) {
					hydratedRef.current = true;
					return;
				}
				(async () => {
					try {
						const ui = await loadUiStateRef.current?.(uiKey === "default" ? void 0 : uiKey);
						if (cancelled || !ui) return;
						if (typeof ui.claimedPageSize === "number" && ui.claimedPageSize > 0) setClaimedPageSize(ui.claimedPageSize);
						if (typeof ui.taskPageSize === "number" && ui.taskPageSize > 0) setTaskPageSize(ui.taskPageSize);
						if (typeof ui.donePageSize === "number" && ui.donePageSize > 0) setDonePageSize(ui.donePageSize);
					} finally {
						if (!cancelled) hydratedRef.current = true;
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [uiKey]);
			const filtered = (0, react.useMemo)(() => activeTasks.filter((t) => {
				if (stateFilter && t.state !== stateFilter) return false;
				if (roleFilter && t.roleAgent !== roleFilter) return false;
				if (requirementFilter && t.requirementId !== requirementFilter) return false;
				if (keyword) {
					const kw = keyword.toLowerCase();
					if (!t.title.toLowerCase().includes(kw) && !t.taskId.toLowerCase().includes(kw)) return false;
				}
				return true;
			}), [
				activeTasks,
				stateFilter,
				roleFilter,
				requirementFilter,
				keyword
			]);
			/** 当前筛选命中的全部已取消任务（批量删除/表头全选的作用域 = 筛选全集，不仅是当前页）。 */
			const filteredDeletedIds = (0, react.useMemo)(() => filtered.filter((t) => t.state === "deleted").map((t) => t.taskId), [filtered]);
			(0, react.useEffect)(() => {
				setSelectedDeleted((prev) => {
					const alive = new Set(filteredDeletedIds);
					let changed = false;
					const next = /* @__PURE__ */ new Set();
					for (const id of prev) if (alive.has(id)) next.add(id);
					else changed = true;
					return changed ? next : prev;
				});
			}, [filteredDeletedIds.join("|")]);
			/**
			* 问题 5：可勾选派发的任务 = 当前筛选命中的 `pending` / `in_progress` 任务。
			* `completed` / `deleted` 是终态（引擎 `Board.startTask` 会拒），故不提供勾选框。
			*/
			const dispatchableIds = (0, react.useMemo)(() => filtered.filter((t) => t.state === "pending" || t.state === "in_progress").map((t) => t.taskId), [filtered]);
			(0, react.useEffect)(() => {
				setSelectedTasks((prev) => {
					if (prev.size === 0) return prev;
					const alive = new Set(dispatchableIds);
					let changed = false;
					const next = /* @__PURE__ */ new Set();
					for (const id of prev) if (alive.has(id)) next.add(id);
					else changed = true;
					return changed ? next : prev;
				});
			}, [dispatchableIds.join("|")]);
			const claimedPaging = usePagination(activeRequirements.length, claimedPageSize);
			const taskPaging = usePagination(filtered.length, taskPageSize);
			const donePaging = usePagination(doneRequirements.length, donePageSize);
			const pageRequirements = claimedPaging.paginate(activeRequirements);
			const pageDone = donePaging.paginate(doneRequirements);
			const pageTasks = taskPaging.paginate(filtered);
			/**
			* 表头全选的作用域：**当前筛选命中的全集**（2026-11-03 用户诉求 1「筛选后支持全选和取消全选」）。
			*
			* 此前作用域是"当前页"（防批量删除误伤看不见的记录）；用户明示要按筛选结果全选，
			* 现改为跨页全集，并配套：① 筛选条提供「全选 / 取消全选」按钮；② 批量删除仍有
			* 带数量的二次确认（"确认删除 N 个已取消任务？"），确认框里的 N 就是筛选全集的数量，
			* 不会出现"只报一个数字、用户不知道范围"的静默误删。
			* 行复选框仍逐条可见可核对；选中集合跨页累积，翻页不清。
			* （`dispatchableIds` / `filteredDeletedIds` 即筛选全集，见上方 useMemo。）
			*/
			/**
			* 问题 2：已完成页的焦点需求（决定下方任务表显示谁）。
			*
			* 焦点必须落在**当前检索命中**的集合里：检索把焦点需求过滤掉后，若不回落，
			* 下方任务表会继续显示一个"列表里根本看不到"的需求，用户会以为列表和详情对不上。
			*/
			const focusRequirementKey = (0, react.useMemo)(() => {
				if (focusKey && doneRequirements.some((r) => `${r.id}@${r.collection}` === focusKey)) return focusKey;
				const first = doneRequirements[0];
				return first ? `${first.id}@${first.collection}` : null;
			}, [focusKey, doneRequirements]);
			const focusRequirement = (0, react.useMemo)(() => focusRequirementKey ? requirements.find((r) => `${r.id}@${r.collection}` === focusRequirementKey) : void 0, [focusRequirementKey, requirements]);
			const focusTasks = (0, react.useMemo)(() => focusRequirementKey ? tasks.filter((t) => t.requirementId === focusRequirementKey) : [], [focusRequirementKey, tasks]);
			const allTasksChecked = dispatchableIds.length > 0 && dispatchableIds.every((id) => selectedTasks.has(id));
			const toggleTask = (id, checked) => {
				setSelectedTasks((prev) => {
					const next = new Set(prev);
					if (checked) next.add(id);
					else next.delete(id);
					return next;
				});
			};
			const toggleAllTasks = (checked) => {
				setSelectedTasks((prev) => {
					const next = new Set(prev);
					for (const id of dispatchableIds) if (checked) next.add(id);
					else next.delete(id);
					return next;
				});
			};
			const persistPageSize = (patch) => {
				if (hydratedRef.current && saveUiStateRef.current) saveUiStateRef.current(patch, uiKey === "default" ? void 0 : uiKey);
			};
			/** 统一跑一个可能失败的动作并刷新；服务端 reason 优先作为结论文案。 */
			const run = async (fn, okText, opts) => {
				setBusy(true);
				setMsg(null);
				try {
					const r = await fn();
					if (r.ok) {
						await props.onRefresh();
						if (r.tagWarning) setMsg({
							tone: "warn",
							text: `${r.reason ?? okText}\n告警：${r.tagWarning}`
						});
						else setMsg({
							tone: "ok",
							text: r.reason ?? okText
						});
						if (opts?.resetTaskPage) taskPaging.resetPage();
					} else setMsg({
						tone: "err",
						text: r.reason ?? "操作失败"
					});
					return r.ok;
				} catch (e) {
					setMsg({
						tone: "err",
						text: e instanceof Error ? e.message : String(e)
					});
					return false;
				} finally {
					setBusy(false);
				}
			};
			/** 问题 8：删除一批已取消任务（单行/批量共用）。 */
			const deleteTasks = async (ids) => {
				if (!props.onDeleteTasks || ids.length === 0) return;
				if (!window.confirm(`确认删除 ${ids.length} 个已取消任务？\n会同时清理其他任务对它们的依赖引用，此操作只影响本地看板（不删除 TFS 工作项）。`)) return;
				await run(async () => {
					const r = await props.onDeleteTasks(ids);
					if (r.ok) {
						setSelectedDeleted((prev) => {
							const next = new Set(prev);
							for (const id of ids) next.delete(id);
							return next;
						});
						return {
							ok: true,
							reason: `已删除 ${r.count ?? ids.length} 个已取消任务`
						};
					}
					return {
						ok: false,
						reason: r.reason
					};
				}, `已删除 ${ids.length} 个任务`);
			};
			/** 问题 7：还原需求回需求池。 */
			const restore = async (key) => {
				if (!props.onRestore) return;
				if (!window.confirm("确认把该需求还原到需求池？\n\n· 需求将从任务中心移除并重新出现在需求池；\n· 其名下「已取消」的任务会被一并清理；\n· 仍有待办/进行中/已完成任务时会被拒绝；\n· 不删除 TFS 工作项（仅移除本地入池标签，移除失败会给出告警）。")) return;
				await run(async () => props.onRestore(key), `已还原 ${key} 到需求池`);
			};
			const toggleDeleted = (id, checked) => {
				setSelectedDeleted((prev) => {
					const next = new Set(prev);
					if (checked) next.add(id);
					else next.delete(id);
					return next;
				});
			};
			const allDeletedChecked = filteredDeletedIds.length > 0 && filteredDeletedIds.every((id) => selectedDeleted.has(id));
			const toggleAllDeleted = (checked) => {
				setSelectedDeleted((prev) => {
					const next = new Set(prev);
					for (const id of filteredDeletedIds) if (checked) next.add(id);
					else next.delete(id);
					return next;
				});
			};
			/**
			* 问题 5：勾选批量派发。
			*
			* 本方法只负责"交出去 + 展示结果"：依赖顺序（有依赖的必须等依赖完成）由编排层
			* （`slots.tsx#dispatchBatch` + `shared/batch-dispatch.ts`）保证 ——
			* 放在这里会让组件同时承担 I/O 编排与渲染两件事，而组件层没有测试手段
			* （客户端半无 React 测试库），出问题时既测不到也说不清。
			*/
			const dispatchBatch = async () => {
				if (!props.onDispatchBatch || selectedTasks.size === 0) return;
				setBusy(true);
				setMsg(null);
				const ids = [...selectedTasks];
				try {
					const r = await props.onDispatchBatch(ids);
					const lines = [r.reason ?? (r.ok ? `已按依赖顺序派发 ${r.dispatched} 个任务` : `批量派发未完成（已派发 ${r.dispatched} 个）`)];
					if (r.waves.length > 0) lines.push(r.waves.map((w, i) => `第 ${i + 1} 波：${w.taskIds.join("、")}${w.failures.length > 0 ? `（失败 ${w.failures.length}）` : ""}`).join("\n"));
					if (r.skipped.length > 0) lines.push(r.skipped.map((s) => `未派发 ${s.taskId}：${s.reason}`).join("\n"));
					setMsg({
						tone: r.ok ? "ok" : "warn",
						text: lines.join("\n")
					});
					setSelectedTasks(/* @__PURE__ */ new Set());
					await props.onRefresh();
				} catch (e) {
					setMsg({
						tone: "err",
						text: e instanceof Error ? e.message : String(e)
					});
				} finally {
					setBusy(false);
				}
			};
			/**
			* 问题 3：保存需求本地字段（提示词 / 工作目录）。
			*
			* 只在成功时关弹框：宿主会因工作目录不存在等原因拒绝保存，此时关闭弹框等于
			* 把用户刚填的一整张表单静默丢弃，用户只能重新打开再填一遍。
			*/
			const saveRequirement = async (key, patch) => {
				if (!props.onUpdateRequirement) return;
				if (await run(async () => {
					const r = await props.onUpdateRequirement(key, patch);
					return r.ok ? {
						ok: true,
						reason: `已更新需求 ${key}`
					} : {
						ok: false,
						reason: r.reason
					};
				}, `已更新需求 ${key}`)) setReqEdit(null);
			};
			/** 问题 4：保存任务字段（提示词 / 模型 / 技能 / MCP / 工作目录）。失败时保留弹框（同 {@link saveRequirement}）。 */
			const saveTask = async (input) => {
				if (!props.onUpdateTask) return;
				if (await run(async () => {
					const r = await props.onUpdateTask(input);
					return r.ok ? {
						ok: true,
						reason: `已更新任务 ${input.taskId}`
					} : {
						ok: false,
						reason: r.reason
					};
				}, `已更新任务 ${input.taskId}`)) setTaskEdit(null);
			};
			/**
			* 问题 5：设置需求执行状态。
			*
			* `'active'`（取消完成）会让需求退回「进行中」页 —— 这是它**唯一**的用途：先取消完成，
			* 之后才可能走到「取消任务 → 还原到需求池」。宿主侧 `Board.restoreRequirement` 对已完成需求
			* 直接拒绝并给出"请先点取消完成"的可读原因，本函数就是那条原因对应的按钮。
			*/
			/**
			* 手动重跑需求完成回写。
			*
			* 传给宿主的是 `force=true`：即便上一份报告是 `ok` 也重跑一遍。回写账本仍会跳过
			* 已成功的项，因此重跑只补 `partial` / `error` 里没写进去的部分，不会把已成功的
			* 字段、结论评论、附件再写一份（这条语义就是 `RequirementFinalizer.runWriteBack`
			* 里 `doneTargets` 不再随 force 清空的依据）。
			*
			* @param key - 需求去重键。
			*/
			const writeBackRequirement = async (key) => {
				if (!props.onWriteBackRequirement) return;
				await run(() => props.onWriteBackRequirement(key), `回写 ${key}`);
			};
			const setReqExecState = async (key, state) => {
				if (!props.onSetRequirementExecState) return;
				await run(async () => {
					const r = await props.onSetRequirementExecState({
						requirementKey: key,
						state
					});
					if (!r.ok) return {
						ok: false,
						reason: r.reason
					};
					return {
						ok: true,
						reason: state === "active" ? `已取消完成：${key} 已退回「进行中」` : `已确认完成：${key} 已迁入「已完成」`
					};
				}, state === "active" ? `已取消完成 ${key}` : `已确认完成 ${key}`);
			};
			/**
			* 需求去重键 → 需求摘要。
			*
			* 任务表只有 `requirementId`（形如 `1997179@WN_HIS`），要拼 TFS 需求页必须回查
			* 需求记录拿 `project` 与 REST `url` —— 任务本身在 TFS 上**没有**对应工作项。
			*/
			const requirementByKey = (0, react.useMemo)(() => {
				const m = /* @__PURE__ */ new Map();
				for (const r of requirements) m.set(`${r.id}@${r.collection}`, r);
				return m;
			}, [requirements]);
			/**
			* 需求 → TFS 需求页（编辑页）。
			* 拼不出完整地址时返回 `undefined`，调用方渲染回退为纯文本（不产出打不开的假链接）。
			*/
			const workItemUrlOf = (r) => r === void 0 ? void 0 : buildWorkItemUrl({
				id: r.id,
				restUrl: r.url,
				project: r.project,
				baseUrl: props.tfsBaseUrl,
				collection: r.collection
			});
			if (!snap) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: 20,
					color: "#6b7280",
					fontSize: 13
				},
				children: "看板加载中…"
			});
			if (!snap.ok) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 20,
					fontSize: 13,
					color: "#b91c1c"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "看板不可用：" }),
					snap.reason ?? "未知原因",
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: 6,
							color: "#7f1d1d",
							fontSize: 12
						},
						children: [
							"看板状态落在插件数据目录的 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "board.json" }),
							"。若该文件存在但无法解析，插件会保留原文件而不重建 （FR-020），请人工检查后再处理。"
						]
					})
				]
			});
			const roles = props.roles;
			const msgColor = msg?.tone === "ok" ? "#047857" : msg?.tone === "warn" ? "#b45309" : "#b91c1c";
			/** 问题 2：本页两个子 Tab 的按钮（与「已完成」页并列，不占用外层工作台的页签）。 */
			const subTabButton = (key, label) => {
				const active = viewTab === key;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-current": active ? "page" : void 0,
					onClick: () => {
						setViewTab(key);
					},
					style: {
						padding: "4px 12px",
						borderRadius: 6,
						border: `1px solid ${active ? "#2563eb" : "#d1d5db"}`,
						background: active ? "#eff6ff" : "#fff",
						color: active ? "#2563eb" : "#4b5563",
						cursor: "pointer",
						fontSize: 13,
						fontWeight: active ? 600 : 400
					},
					children: label
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontFamily: "system-ui, sans-serif",
					color: "#111827"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							marginBottom: 12,
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: { margin: 0 },
								children: "任务中心"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									display: "inline-flex",
									gap: 6
								},
								children: [subTabButton("active", `进行中（${activeRequirements.length}）`), subTabButton("done", `已完成（${doneRequirementsAll.length}）`)]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: [
									"待办 ",
									snap.counts.pending,
									" ｜ 进行中 ",
									snap.counts.inProgress,
									" ｜ 已完成 ",
									snap.counts.completed,
									" ｜ 运行 ",
									snap.counts.running,
									" ｜ 排队 ",
									snap.counts.queued
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: {
									...buttonStyle$1,
									marginLeft: "auto"
								},
								disabled: busy,
								onClick: () => {
									Promise.resolve(props.onRefresh());
								},
								children: "刷新"
							})
						]
					}),
					msg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginBottom: 10,
							fontSize: 13,
							color: msgColor,
							whiteSpace: "pre-wrap"
						},
						children: msg.text
					}),
					viewTab === "active" && snap.version === 0 && requirements.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...sectionStyle$1,
							color: "#6b7280",
							fontSize: 13
						},
						children: "看板为空。请到「需求池」按工作项 ID 领取需求，再回到此处拆解为任务。"
					}),
					viewTab === "active" && props.onListSchedules && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$1,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 8
								},
								children: [
									"定时执行（",
									scheduleEntries.length,
									"）",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontWeight: 400,
											color: "#6b7280",
											marginLeft: 6
										},
										children: "｜ 到点自动派发/编排，可修改执行时间或取消"
									})
								]
							}),
							scheduleMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginBottom: 8,
									fontSize: 12,
									color: scheduleMsg.tone === "ok" ? "#047857" : "#b91c1c",
									whiteSpace: "pre-wrap"
								},
								children: scheduleMsg.text
							}),
							scheduleEntries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#6b7280"
								},
								children: "暂无待执行的定时条目。"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { overflowX: "auto" },
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									style: {
										width: "100%",
										borderCollapse: "collapse"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: {
											textAlign: "left",
											color: "#6b7280"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "类型"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "备注"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "到点时间（本地）"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "登记于"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: cellStyle })
										]
									}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: scheduleEntries.map((e) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: { borderTop: "1px solid #f3f4f6" },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
													text: e.kind === "chain" ? "定时编排" : "定时执行",
													color: "#7c3aed",
													bg: "#f5f3ff"
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: {
													...cellStyle,
													maxWidth: 300
												},
												title: e.note ?? e.id,
												children: [e.note ?? e.id, e.requirementKey && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														fontSize: 11,
														color: "#9ca3af"
													},
													children: ["需求 ", e.requirementKey]
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: scheduleEdit?.id === e.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: {
														display: "inline-flex",
														gap: 6,
														alignItems: "center",
														flexWrap: "wrap"
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "datetime-local",
															style: inputStyle$1,
															value: scheduleEdit.dueAtLocal,
															onChange: (ev) => setScheduleEdit({
																id: e.id,
																dueAtLocal: ev.target.value
															})
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															style: {
																...buttonStyle$1,
																padding: "3px 8px",
																fontSize: 12
															},
															onClick: () => void commitScheduleTime(e.id),
															children: "保存"
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															style: {
																...buttonStyle$1,
																padding: "3px 8px",
																fontSize: 12
															},
															onClick: () => setScheduleEdit(null),
															children: "放弃"
														})
													]
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													title: e.dueAt,
													children: formatLocalMinute(e.dueAt)
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													title: e.createdAt,
													children: formatLocalMinute(e.createdAt)
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													...cellStyle,
													whiteSpace: "nowrap"
												},
												children: scheduleEdit?.id !== e.id && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: {
														...buttonStyle$1,
														marginRight: 6,
														padding: "3px 8px",
														fontSize: 12
													},
													onClick: () => setScheduleEdit({
														id: e.id,
														dueAtLocal: toDateTimeLocal(e.dueAt)
													}),
													children: "改时间"
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: {
														...buttonStyle$1,
														padding: "3px 8px",
														fontSize: 12,
														color: "#b91c1c"
													},
													onClick: () => void cancelScheduleEntry(e.id),
													children: "取消"
												})] })
											})
										]
									}, e.id)) })]
								})
							})
						]
					}),
					viewTab === "active" && activeRequirements.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$1,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 8
								},
								children: [
									"已领取需求（",
									activeRequirements.length,
									"）",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontWeight: 400,
											color: "#6b7280",
											marginLeft: 6
										},
										children: "｜ 点行切换右侧主对话框，并筛选下方任务列表"
									}),
									doneRequirementsAll.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											fontWeight: 400,
											color: "#6b7280",
											marginLeft: 6
										},
										children: [
											"｜ ",
											doneRequirementsAll.length,
											" 条已完成在「已完成」页"
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { overflowX: "auto" },
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									style: {
										width: "100%",
										borderCollapse: "collapse"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: {
											textAlign: "left",
											color: "#6b7280"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "去重键"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "标题"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "执行状态"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "TFS 状态"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: cellStyle,
												children: "标签"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: cellStyle })
										]
									}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: pageRequirements.map((r) => {
										const key = `${r.id}@${r.collection}`;
										const ownTasks = tasks.filter((t) => t.requirementId === key);
										const activeCount = ownTasks.filter((t) => t.state !== "deleted").length;
										const deletedCount = ownTasks.length - activeCount;
										const isChatFocus = key === chatFocusKey;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											onClick: () => {
												setDialogFocusKey(key);
												setRequirementFilter(key);
												taskPaging.resetPage();
											},
											title: "点击切换右侧主对话框到该需求，并筛选任务列表只看该需求的任务",
											"aria-current": isChatFocus ? "true" : void 0,
											style: {
												cursor: "pointer",
												background: isChatFocus ? "#f0f9ff" : void 0,
												boxShadow: isChatFocus ? "inset 3px 0 0 #2563eb" : void 0
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle,
													children: key
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
													style: {
														...cellStyle,
														maxWidth: 320
													},
													title: r.title,
													children: [
														(() => {
															const href = workItemUrlOf(r);
															return href ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
																href,
																target: "_blank",
																rel: "noreferrer noopener",
																style: {
																	color: "#2563eb",
																	textDecoration: "none"
																},
																title: `在 TFS 中打开需求 #${r.id}：${href}`,
																onClick: (e) => e.stopPropagation(),
																children: [r.title, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	style: {
																		marginLeft: 4,
																		fontSize: 11,
																		color: "#6b7280"
																	},
																	children: "↗"
																})]
															}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: r.title });
														})(),
														r.prompt && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															style: {
																color: "#6d28d9",
																fontSize: 11
															},
															title: r.prompt,
															children: [
																"提示词：",
																r.prompt.slice(0, 40),
																r.prompt.length > 40 ? "…" : ""
															]
														}),
														r.workspace && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															style: {
																color: "#9ca3af",
																fontSize: 11
															},
															title: r.workspace,
															children: ["工作目录：", r.workspace]
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle,
													children: (() => {
														const s = summarizeRequirementExec(r, ownTasks, scheduleDueByRequirement.get(key));
														const st = REQ_EXEC_STYLE[s.tone];
														return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
															text: s.text,
															color: st.color,
															bg: st.bg
														});
													})()
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle,
													children: r.state
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: cellStyle,
													children: r.tags.join("、") || "-"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
													style: {
														...cellStyle,
														whiteSpace: "nowrap"
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															style: {
																...buttonStyle$1,
																marginRight: 6
															},
															disabled: busy,
															onClick: (e) => {
																e.stopPropagation();
																setDecomposeTarget(r);
															},
															title: "重新拆解会把已取消的任务原地重建为全新待办任务；在办/已完成任务跳过",
															children: ownTasks.length > 0 ? `重新拆解（在办 ${activeCount}${deletedCount ? ` / 已取消 ${deletedCount}` : ""}）` : "拆解为任务"
														}),
														props.onSelectRequirement && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															style: {
																...buttonStyle$1,
																marginRight: 6
															},
															onClick: (e) => {
																e.stopPropagation();
																props.onSelectRequirement?.(r);
															},
															children: "选为目标"
														}),
														props.onUpdateRequirement && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															style: {
																...buttonStyle$1,
																marginRight: 6
															},
															disabled: busy,
															title: "编辑该需求的提示词与工作目录",
															onClick: (e) => {
																e.stopPropagation();
																setReqEdit(r);
															},
															children: "编辑"
														}),
														props.onSetRequirementExecState && activeCount === 0 && deletedCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															style: {
																...buttonStyle$1,
																marginRight: 6
															},
															disabled: busy,
															title: "全部任务都已取消：手动确认需求已处理完，归入「已完成」页（可再「取消完成」撤回）",
															onClick: (e) => {
																e.stopPropagation();
																setReqExecState(key, "completed");
															},
															children: "标记完成"
														}),
														props.onRestore && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															style: dangerButtonStyle,
															disabled: busy || activeCount > 0,
															title: activeCount > 0 ? "仍有未取消的任务，无法还原" : "还原到需求池（清理已取消任务）",
															onClick: (e) => {
																e.stopPropagation();
																restore(key);
															},
															children: "还原到需求池"
														})
													]
												})
											]
										}, key);
									}) })]
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaginationBar, {
								label: "已领取需求",
								total: activeRequirements.length,
								page: claimedPaging.page,
								pageCount: claimedPaging.pageCount,
								pageSize: claimedPageSize,
								pageSizeOptions: CLAIMED_PAGE_SIZE_OPTIONS,
								onPageChange: claimedPaging.setPage,
								onPageSizeChange: (size) => {
									setClaimedPageSize(size);
									claimedPaging.resetPage();
									persistPageSize({ claimedPageSize: size });
								}
							})
						]
					}),
					viewTab === "active" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$1,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									flexWrap: "wrap",
									alignItems: "center"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: inputStyle$1,
										value: stateFilter,
										onChange: (e) => {
											setStateFilter(e.target.value);
											taskPaging.resetPage();
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: "全部状态"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "pending",
												children: "待办"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "in_progress",
												children: "进行中"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "completed",
												children: "已完成"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "deleted",
												children: "已取消"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: inputStyle$1,
										value: roleFilter,
										onChange: (e) => {
											setRoleFilter(e.target.value);
											taskPaging.resetPage();
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "全部角色"
										}), roles.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: r.name,
											children: r.name
										}, r.id))]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: inputStyle$1,
										value: requirementFilter,
										onChange: (e) => {
											setRequirementFilter(e.target.value);
											setDialogFocusKey(e.target.value);
											taskPaging.resetPage();
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "全部需求"
										}), activeRequirements.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: `${r.id}@${r.collection}`,
											children: [
												r.id,
												" ",
												r.title.slice(0, 24)
											]
										}, `${r.id}@${r.collection}`))]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: inputStyle$1,
										placeholder: "标题/任务 ID 关键字",
										value: keyword,
										onChange: (e) => {
											setKeyword(e.target.value);
											taskPaging.resetPage();
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											fontSize: 12,
											color: "#6b7280"
										},
										children: [
											"命中 ",
											filtered.length,
											" / 共 ",
											activeTasks.length
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...buttonStyle$1,
											padding: "4px 10px",
											fontSize: 12
										},
										disabled: dispatchableIds.length === 0 && filteredDeletedIds.length === 0,
										title: "勾选当前筛选命中的全部可操作任务（可派发 + 已取消，跨页）",
										onClick: () => {
											toggleAllTasks(true);
											toggleAllDeleted(true);
										},
										children: "全选"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...buttonStyle$1,
											padding: "4px 10px",
											fontSize: 12
										},
										disabled: selectedTasks.size === 0 && selectedDeleted.size === 0,
										onClick: () => {
											toggleAllTasks(false);
											toggleAllDeleted(false);
										},
										children: "取消全选"
									})
								]
							}),
							props.onDeleteTasks && selectedDeleted.size > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 10,
									marginTop: 8,
									padding: "6px 10px",
									background: "#fef2f2",
									border: "1px solid #fecaca",
									borderRadius: 6,
									fontSize: 12,
									color: "#b91c1c"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										"已选 ",
										selectedDeleted.size,
										" 个已取消任务"
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: dangerButtonStyle,
										disabled: busy,
										onClick: () => void deleteTasks([...selectedDeleted]),
										children: "批量删除"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: buttonStyle$1,
										onClick: () => setSelectedDeleted(/* @__PURE__ */ new Set()),
										children: "清空选择"
									})
								]
							}),
							props.onDispatchBatch && selectedTasks.size > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 10,
									marginTop: 8,
									padding: "6px 10px",
									background: "#eff6ff",
									border: "1px solid #bfdbfe",
									borderRadius: 6,
									fontSize: 12,
									color: "#1d4ed8"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										"已选 ",
										selectedTasks.size,
										" 个任务"
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: {
											...buttonStyle$1,
											background: "#2563eb",
											color: "#fff",
											borderColor: "#2563eb"
										},
										disabled: busy || orchestrationBlocked,
										title: orchestrationBlocked ? `派发已被前置阻断：${props.orchestration?.reason ?? "编排能力不可用"}` : "按 DAG 分波派发：依赖未完成的任务会等到依赖完成后再开始",
										onClick: () => void dispatchBatch(),
										children: "批量派发执行"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: buttonStyle$1,
										disabled: busy,
										onClick: () => setSelectedTasks(/* @__PURE__ */ new Set()),
										children: "清空选择"
									}),
									props.batchProgress && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { color: "#1e40af" },
										children: props.batchProgress
									})
								]
							})
						]
					}),
					viewTab === "active" && activeTasks.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$1,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { overflowX: "auto" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								style: {
									width: "100%",
									borderCollapse: "collapse"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									style: {
										textAlign: "left",
										color: "#6b7280"
									},
									children: [
										props.onDeleteTasks && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: {
												...cellStyle,
												width: 32
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												"aria-label": "全选当前筛选下的已取消任务",
												checked: allDeletedChecked,
												disabled: filteredDeletedIds.length === 0,
												onChange: (e) => toggleAllDeleted(e.target.checked)
											})
										}),
										props.onDispatchBatch && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: {
												...cellStyle,
												width: 32
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												"aria-label": "全选当前筛选下可派发的任务",
												checked: allTasksChecked,
												disabled: dispatchableIds.length === 0,
												onChange: (e) => toggleAllTasks(e.target.checked)
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "任务"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "需求"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "状态"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "执行"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "工作目录"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "角色"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "依赖"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "尝试"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: cellStyle })
									]
								}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [pageTasks.map((t) => {
									const st = t.execState === "failed" && t.state === "in_progress" ? STATE_STYLE._failed_override : STATE_STYLE[t.state] ?? {
										color: "#374151",
										bg: "#f3f4f6",
										label: t.state
									};
									const ex = EXEC_STYLE[t.execState] ?? {
										color: "#374151",
										label: t.execState
									};
									const waiting = t.state === "pending" && t.blockedBy.length > 0;
									const deletable = t.state === "deleted" && !!props.onDeleteTasks;
									const dispatchable = (t.state === "pending" || t.state === "in_progress") && !!props.onDispatchBatch;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: t.state === "deleted" ? { color: "#9ca3af" } : void 0,
										children: [
											props.onDeleteTasks && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: deletable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													"aria-label": `选择已取消任务 ${t.taskId}`,
													checked: selectedDeleted.has(t.taskId),
													onChange: (e) => toggleDeleted(t.taskId, e.target.checked)
												})
											}),
											props.onDispatchBatch && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: dispatchable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													"aria-label": `选择待派发任务 ${t.taskId}`,
													checked: selectedTasks.has(t.taskId),
													disabled: busy,
													onChange: (e) => toggleTask(t.taskId, e.target.checked)
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: cellStyle,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														style: {
															display: "flex",
															alignItems: "baseline",
															gap: 4
														},
														children: props.onGetTaskTrace ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															onClick: () => setDetailTaskId(t.taskId),
															title: "查看任务执行过程详情（技能/MCP/工具调用时间线、失败原因、追问）",
															style: {
																background: "none",
																border: "none",
																padding: 0,
																margin: 0,
																textAlign: "left",
																font: "inherit",
																fontWeight: 600,
																color: "#1d4ed8",
																cursor: "pointer",
																textDecoration: "underline",
																textDecorationStyle: "dotted",
																textUnderlineOffset: 3
															},
															children: t.title
														}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t.title })
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: {
															color: "#9ca3af",
															fontSize: 11
														},
														children: [
															t.taskId,
															t.autoLaunched && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																title: "上游任务完成后由宿主自动启动（自动链式执行）",
																style: {
																	display: "inline-block",
																	marginLeft: 6,
																	padding: "0 5px",
																	borderRadius: 4,
																	background: "#ecfdf5",
																	color: "#047857",
																	fontSize: 10
																},
																children: "自动"
															}),
															t.lastNote ? ` ｜ ${t.lastNote}` : ""
														]
													}),
													t.state === "in_progress" && t.execState === "needs_confirmation" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: {
															marginTop: 3,
															padding: "2px 6px",
															borderRadius: 4,
															background: "#fff7ed",
															border: "1px solid #fed7aa",
															color: "#c2410c",
															fontSize: 11
														},
														title: t.lastNote ?? "子代理提示需要人工确认",
														children: ["待人工确认：", stripConfirmPrefix(t.lastNote) || "子代理已产出结论，请人工核对后点「确认通过」"]
													}),
													t.prompt && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: {
															color: "#6d28d9",
															fontSize: 11
														},
														title: t.prompt,
														children: [
															"提示词：",
															t.prompt.slice(0, 40),
															t.prompt.length > 40 ? "…" : ""
														]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: {
															color: "#9ca3af",
															fontSize: 10
														},
														children: [
															"模型 ",
															t.frozenConfig.model ? formatModelRoute(props.modelOptions, t.frozenConfig.model, t.frozenConfig.modelProvider) : "（默认）",
															t.frozenConfig.skills.length > 0 ? ` ｜ 技能 ${t.frozenConfig.skills.length}` : "",
															t.frozenConfig.workflow ? ` ｜ 工作流 ${t.frozenConfig.workflow}` : "",
															t.frozenConfig.mcp.length > 0 ? ` ｜ MCP ${t.frozenConfig.mcp.join("、")}` : ""
														]
													})
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: (() => {
													const href = workItemUrlOf(requirementByKey.get(t.requirementId));
													return href ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
														href,
														target: "_blank",
														rel: "noreferrer noopener",
														style: {
															color: "#2563eb",
															textDecoration: "none"
														},
														title: `在 TFS 中打开需求 ${t.requirementId}：${href}`,
														children: [t.requirementId, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																marginLeft: 4,
																fontSize: 11,
																color: "#6b7280"
															},
															children: "↗"
														})]
													}) : t.requirementId;
												})()
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
													text: st.label,
													color: st.color,
													bg: st.bg
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: cellStyle,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
													text: ex.label,
													color: ex.color,
													bg: t.execState === "failed" ? "#fee2e2" : t.execState === "running" ? "#dbeafe" : "#f3f4f6"
												}), waiting && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														fontSize: 11,
														color: "#b45309",
														marginTop: 2
													},
													children: [
														"等待依赖（",
														t.blockedBy.length,
														"）"
													]
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													...cellStyle,
													maxWidth: 200
												},
												children: t.workspace ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													title: t.workspace,
													style: {
														display: "inline-block",
														maxWidth: 190,
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
														verticalAlign: "bottom",
														fontFamily: "monospace",
														fontSize: 11,
														color: "#374151"
													},
													children: t.workspace
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: {
														color: "#9ca3af",
														fontSize: 11
													},
													children: "未接线"
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													style: {
														...inputStyle$1,
														padding: "2px 4px",
														fontSize: 11
													},
													value: t.roleAgent,
													disabled: busy || t.state === "completed" || t.state === "deleted",
													onChange: (e) => run(() => props.onAssign(t.taskId, e.target.value), `已改派 ${t.taskId} → ${e.target.value}`),
													children: [!roles.some((r) => r.name === t.roleAgent) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: t.roleAgent,
														children: [t.roleAgent, "（未知）"]
													}), roles.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: r.name,
														children: r.name
													}, r.id))]
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: t.blockedBy.join(", ") || "-"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: t.attemptCount
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: {
													...cellStyle,
													whiteSpace: "nowrap"
												},
												children: [
													props.onUpdateTask && taskEditable(t) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...buttonStyle$1,
															marginRight: 4
														},
														disabled: busy,
														title: "编辑该任务的提示词、模型、预设、技能、工作流、MCP 与执行预算",
														onClick: () => setTaskEdit(t),
														children: "编辑"
													}),
													props.onDispatchTask && (t.state === "pending" || t.state === "in_progress") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...buttonStyle$1,
															marginRight: 4,
															background: "#eff6ff",
															borderColor: "#93c5fd"
														},
														disabled: busy || orchestrationBlocked,
														title: orchestrationBlocked ? `派发已被前置阻断：${props.orchestration?.reason ?? "编排能力不可用"}` : void 0,
														onClick: () => run(() => props.onDispatchTask(t), `已派发 ${t.taskId} → ${t.roleAgent}（run 结束后自动回写看板）`),
														children: "派发执行"
													}),
													actionsFor(t).map((a) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...buttonStyle$1,
															marginRight: 4
														},
														disabled: busy,
														onClick: () => run(() => props.onTaskState(t.taskId, a, t.revision), `${actionLabel(a, t)}：${t.taskId} 已更新`),
														children: actionLabel(a, t)
													}, a)),
													deletable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...dangerButtonStyle,
															marginRight: 4
														},
														disabled: busy,
														title: "删除该已取消任务（同时清理依赖引用）",
														onClick: () => void deleteTasks([t.taskId]),
														children: "删除"
													})
												]
											})
										]
									}, t.taskId);
								}), pageTasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									colSpan: 9 + (props.onDeleteTasks ? 1 : 0) + (props.onDispatchBatch ? 1 : 0),
									style: {
										...cellStyle,
										color: "#9ca3af",
										textAlign: "center",
										padding: 16
									},
									children: "当前筛选无任务"
								}) })] })]
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaginationBar, {
							label: "任务",
							total: filtered.length,
							page: taskPaging.page,
							pageCount: taskPaging.pageCount,
							pageSize: taskPageSize,
							pageSizeOptions: TASK_PAGE_SIZE_OPTIONS,
							onPageChange: taskPaging.setPage,
							onPageSizeChange: (size) => {
								setTaskPageSize(size);
								taskPaging.resetPage();
								persistPageSize({ taskPageSize: size });
							}
						})]
					}),
					viewTab === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$1,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								flexWrap: "wrap",
								marginBottom: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 13,
										fontWeight: 600
									},
									children: [
										"已完成需求（",
										doneRequirementsAll.length,
										"）"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: {
										...inputStyle$1,
										minWidth: 220
									},
									placeholder: "按需求 ID 或标题检索…",
									"aria-label": "检索已完成需求",
									value: doneKeyword,
									onChange: (e) => {
										setDoneKeyword(e.target.value);
										donePaging.resetPage();
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 12,
										color: "#6b7280"
									},
									children: ["命中 ", doneRequirements.length]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 12,
										color: "#6b7280",
										marginLeft: "auto"
									},
									children: "全部任务完成后自动迁入；点「取消完成」退回「进行中」"
								})
							]
						}), doneRequirementsAll.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								color: "#6b7280",
								padding: 12
							},
							children: "暂无已完成需求。一条需求名下的任务全部完成后，它会自动出现在这里。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { overflowX: "auto" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								style: {
									width: "100%",
									borderCollapse: "collapse"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									style: {
										textAlign: "left",
										color: "#6b7280"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "去重键"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "标题"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "执行状态"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "完成时间"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "标签"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: cellStyle })
									]
								}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [pageDone.map((r) => {
									const key = `${r.id}@${r.collection}`;
									const ownTasks = tasks.filter((t) => t.requirementId === key);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										onClick: () => setFocusKey(key),
										title: "点击选中：下方显示该需求的任务",
										style: {
											cursor: "pointer",
											background: key === focusRequirementKey ? "#f0f9ff" : void 0
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: key
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: {
													...cellStyle,
													maxWidth: 320
												},
												title: r.title,
												children: [(() => {
													const href = workItemUrlOf(r);
													return href ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
														href,
														target: "_blank",
														rel: "noreferrer noopener",
														style: {
															color: "#2563eb",
															textDecoration: "none"
														},
														title: `在 TFS 中打开需求 #${r.id}：${href}`,
														onClick: (e) => e.stopPropagation(),
														children: [r.title, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																marginLeft: 4,
																fontSize: 11,
																color: "#6b7280"
															},
															children: "↗"
														})]
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: r.title });
												})(), r.workspace && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														color: "#9ca3af",
														fontSize: 11
													},
													title: r.workspace,
													children: ["工作目录：", r.workspace]
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: (() => {
													const s = summarizeRequirementExec(r, ownTasks);
													const st = REQ_EXEC_STYLE[s.tone];
													return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
														text: s.text,
														color: st.color,
														bg: st.bg
													});
												})()
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													...cellStyle,
													whiteSpace: "nowrap"
												},
												children: r.completedAt ? new Date(r.completedAt).toLocaleString() : "-"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: cellStyle,
												children: r.tags.join("、") || "-"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: {
													...cellStyle,
													whiteSpace: "nowrap"
												},
												children: [
													props.onSelectRequirement && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...buttonStyle$1,
															marginRight: 6
														},
														onClick: (e) => {
															e.stopPropagation();
															props.onSelectRequirement?.(r);
														},
														children: "选为目标"
													}),
													r.writeBack && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: {
															fontSize: 11,
															marginRight: 6,
															color: WRITEBACK_TONE[r.writeBack.status].color
														},
														title: r.writeBack.items.filter((i) => i.status !== "ok").map((i) => `${i.target}：${i.reason ?? i.status}`).join("\n") || r.writeBack.summary || "",
														children: ["回写 ", WRITEBACK_TONE[r.writeBack.status].label]
													}),
													props.onWriteBackRequirement && r.writeBack && r.writeBack.status !== "ok" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...buttonStyle$1,
															marginRight: 6
														},
														disabled: busy,
														title: "重跑需求完成回写：只补上次未成功的项，已成功的字段/评论/附件不会重复写入",
														onClick: (e) => {
															e.stopPropagation();
															writeBackRequirement(key);
														},
														children: "重新回写"
													}),
													"                        ",
													props.onSetRequirementExecState && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: {
															...buttonStyle$1,
															marginRight: 6
														},
														disabled: busy,
														title: "取消完成：该需求退回「进行中」页；之后可取消其任务并还原到需求池",
														onClick: (e) => {
															e.stopPropagation();
															setReqExecState(key, "active");
														},
														children: "取消完成"
													}),
													props.onRestore && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														style: dangerButtonStyle,
														disabled: true,
														title: "已完成需求不可直接还原：请先点「取消完成」退回进行中，再取消其任务后还原",
														onClick: (e) => e.stopPropagation(),
														children: "还原到需求池"
													})
												]
											})
										]
									}, key);
								}), pageDone.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									colSpan: 6,
									style: {
										...cellStyle,
										color: "#9ca3af",
										textAlign: "center",
										padding: 16
									},
									children: "当前检索无匹配的已完成需求"
								}) })] })]
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaginationBar, {
							label: "已完成需求",
							total: doneRequirements.length,
							page: donePaging.page,
							pageCount: donePaging.pageCount,
							pageSize: donePageSize,
							pageSizeOptions: CLAIMED_PAGE_SIZE_OPTIONS,
							onPageChange: donePaging.setPage,
							onPageSizeChange: (size) => {
								setDonePageSize(size);
								donePaging.resetPage();
								persistPageSize({ donePageSize: size });
							}
						})] })]
					}),
					viewTab === "done" && focusRequirement && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle$1,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 13,
								fontWeight: 600,
								marginBottom: 8
							},
							children: [
								"需求 ",
								focusRequirementKey,
								" 的任务（",
								focusTasks.length,
								"）",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontWeight: 400,
										color: "#6b7280",
										marginLeft: 6
									},
									children: "｜ 点任务名查看执行过程（工具调用时间线 / 失败原因 / 追问）"
								})
							]
						}), focusTasks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: "#9ca3af",
								padding: 8
							},
							children: "该需求下暂无任务记录。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { overflowX: "auto" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								style: {
									width: "100%",
									borderCollapse: "collapse"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									style: {
										textAlign: "left",
										color: "#6b7280"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "任务"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "状态"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "执行"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "角色"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: "尝试"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											style: cellStyle,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: { fontWeight: 400 },
												children: "执行过程"
											})
										})
									]
								}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: focusTasks.map((t) => {
									const st = STATE_STYLE[t.state] ?? {
										color: "#374151",
										bg: "#f3f4f6",
										label: t.state
									};
									const ex = EXEC_STYLE[t.execState] ?? {
										color: "#374151",
										label: t.execState
									};
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											style: cellStyle,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: { fontWeight: 600 },
													children: t.title
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: {
														color: "#9ca3af",
														fontSize: 11
													},
													children: t.taskId
												}),
												t.lastNote && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: {
														color: "#9ca3af",
														fontSize: 11
													},
													title: t.lastNote,
													children: t.lastNote.slice(0, 60)
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											style: cellStyle,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
												text: st.label,
												color: st.color,
												bg: st.bg
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											style: cellStyle,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
												text: ex.label,
												color: ex.color,
												bg: t.execState === "failed" ? "#fee2e2" : t.execState === "running" ? "#dbeafe" : "#f3f4f6"
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											style: cellStyle,
											children: t.roleAgent || "-"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											style: cellStyle,
											children: t.attemptCount
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											style: {
												...cellStyle,
												whiteSpace: "nowrap"
											},
											children: props.onGetTaskTrace ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												style: {
													...buttonStyle$1,
													marginRight: 4
												},
												title: "查看该任务的执行过程（技能/MCP/工具调用时间线）",
												onClick: () => setDetailTaskId(t.taskId),
												children: "查看执行过程"
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													color: "#9ca3af",
													fontSize: 11
												},
												children: "宿主未提供轨迹服务"
											})
										})
									] }, t.taskId);
								}) })]
							})
						})]
					}),
					reqEdit && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RequirementEditDialog, {
						requirement: reqEdit,
						workspaces: props.workspaces ?? [],
						busy,
						onCancel: () => setReqEdit(null),
						onSave: (patch) => void saveRequirement(`${reqEdit.id}@${reqEdit.collection}`, patch)
					}),
					decomposeTarget && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DecomposeDialog, {
						requirement: decomposeTarget,
						workspaces: props.workspaces ?? [],
						busy,
						onCancel: () => setDecomposeTarget(null),
						onConfirm: async (plan) => {
							const key = `${decomposeTarget.id}@${decomposeTarget.collection}`;
							const ws = plan.workspace.trim();
							if (!ws && !decomposeTarget.workspace) return "请先设置工作目录（拆解出的任务会继承它，子 agent 据此定位代码库）";
							let dueIso;
							if (plan.mode === "at") {
								const v = parseDateTimeLocal(plan.dueAtLocal);
								if (!v.ok) return v.reason;
								dueIso = v.plan.dueAt;
							}
							if (ws && ws !== (decomposeTarget.workspace ?? "") && props.onUpdateRequirement) {
								const r = await props.onUpdateRequirement(key, { workspace: ws });
								if (!r.ok) return r.reason ?? "保存工作目录失败";
							}
							setDecomposeTarget(null);
							if (!await run(() => props.onDecompose(key), `已拆解 ${key}`, { resetTaskPage: true })) return null;
							if (props.onOrchestrationStart) {
								const start = await props.onOrchestrationStart(key, {
									mode: plan.mode,
									sequential: true,
									...dueIso ? { dueAt: dueIso } : {}
								});
								setMsg(start.ok ? {
									tone: "ok",
									text: plan.mode === "at" ? `已登记定时编排：到 ${formatLocalMinute(start.scheduledAt)}（本地时间）主 agent 自动开始` : "已开始编排（串行：上个任务完成才编排下个）"
								} : {
									tone: "err",
									text: `拆解完成，但开始编排失败：${start.reason ?? "未知原因"}`
								});
							}
							return null;
						}
					}),
					taskEdit && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskEditDialog, {
						task: taskEdit,
						workspaces: props.workspaces ?? [],
						modelOptions: props.modelOptions ?? [],
						skillOptions: props.skillOptions ?? [],
						mcpServers: props.mcpServers ?? [],
						skillGroups: props.skillGroups ?? [],
						presets: props.presets ?? [],
						busy,
						onCancel: () => setTaskEdit(null),
						onSave: (input) => void saveTask(input)
					}),
					detailTask && props.onGetTaskTrace && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskDetailDialog, {
						task: detailTask,
						onClose: () => setDetailTaskId(null),
						onGetTrace: props.onGetTaskTrace,
						onFollowUp: async (input) => {
							if (!props.onFollowUpTask) return {
								ok: false,
								reason: "当前宿主不支持追问"
							};
							return props.onFollowUpTask(input);
						},
						onFollowedUp: async () => {
							await props.onRefresh();
						},
						onConfirm: async () => {
							const r = await props.onTaskState(detailTask.taskId, "confirm", detailTask.revision);
							return {
								ok: r.ok,
								reason: r.reason
							};
						}
					})
				]
			});
		}
		const overlayStyle = {
			position: "fixed",
			inset: 0,
			background: "rgba(0,0,0,0.35)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			zIndex: 60
		};
		const dialogStyle = {
			background: "#fff",
			borderRadius: 10,
			padding: 18,
			maxWidth: 640,
			width: "92%",
			maxHeight: "82vh",
			overflow: "auto"
		};
		const fieldLabelStyle = {
			display: "block",
			fontSize: 12,
			color: "#6b7280",
			margin: "10px 0 4px"
		};
		const fieldStyle = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		/**
		* 需求编辑弹框（问题 3：已领取需求增加提示词、切换工作目录）。
		*
		* 只改**本地补充字段**：TFS 侧字段（标题/状态/标签）走执行配置页的「确认回写」，
		* 那里过写门禁与审计。弹框里明确写出这条边界，避免用户以为这里能改 TFS 上的东西。
		*/
		function RequirementEditDialog(props) {
			const key = `${props.requirement.id}@${props.requirement.collection}`;
			const [prompt, setPrompt] = (0, react.useState)(props.requirement.prompt ?? "");
			const [workspace, setWorkspace] = (0, react.useState)(props.requirement.workspace ?? "");
			const listed = props.workspaces.some((w) => w.path === workspace);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: overlayStyle,
				onClick: props.onCancel,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: dialogStyle,
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
							style: { margin: "0 0 6px" },
							children: [
								"编辑需求：",
								props.requirement.id,
								" ",
								props.requirement.title
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 12,
								color: "#6b7280"
							},
							children: [key, " ｜ 只编辑本地补充字段（提示词/工作目录）；TFS 上的标题/状态/标签请用「执行配置 → 确认回写」（过写门禁）。"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "增加提示词（需求级；派发该需求下任一任务时拼在任务提示词之前）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							style: {
								...fieldStyle,
								minHeight: 110
							},
							placeholder: "留空 = 清空该需求已有的提示词",
							value: prompt,
							onChange: (e) => setPrompt(e.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "工作目录（由拆解出的任务继承；不改变子代理进程 cwd）"
						}),
						props.workspaces.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: {
								...fieldStyle,
								marginBottom: 6
							},
							value: listed ? workspace : "",
							onChange: (e) => setWorkspace(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "— 从 dsh 已添加的工作区选择 —"
							}), props.workspaces.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: w.path,
								children: [w.title, w.path ? `（${w.path}）` : ""]
							}, w.id))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: fieldStyle,
							placeholder: "绝对路径，如 D:\\\\code\\\\his；留空 = 清空",
							value: workspace,
							onChange: (e) => setWorkspace(e.target.value)
						}),
						props.workspaces.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#b45309",
								marginTop: 2
							},
							children: "宿主未返回工作区清单（能力降级）：只能手填绝对路径。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 14,
								display: "flex",
								gap: 8,
								justifyContent: "flex-end"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...buttonStyle$1,
									background: "#2563eb",
									color: "#fff",
									borderColor: "#2563eb"
								},
								disabled: props.busy,
								onClick: () => props.onSave({
									prompt: prompt.trim() || null,
									workspace: workspace.trim() || null
								}),
								children: "保存"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: props.busy,
								onClick: props.onCancel,
								children: "取消"
							})]
						})
					]
				})
			});
		}
		/**
		* 拆解弹框（2026-11-03 问题 2/5）。
		*
		*   - **问题 2**：需求没配工作目录时弹出「设置工作目录」且必填（拆解出的任务会继承它，
		*     子 agent 据 prompt 里的硬约束定位代码库）；已配过则可改可留空。
		*   - **问题 5**：执行时机 立刻（默认）/ 定时（`datetime-local`，精确到分）。
		*     立刻 = 拆解成功后主 agent 立即**串行**编排（上个任务完成才编排下个，依赖序由
		*     任务 `blockedBy` 保证）；定时 = 登记到点自动开始（落盘，重启补跑）。
		*
		* `onConfirm` 返回 null = 成功（弹框关闭，结果经主消息区展示）；返回字符串 = 弹框内
		* 展示该原因并保持打开（供用户改完重试）。
		*/
		function DecomposeDialog(props) {
			const needWorkspace = !(props.requirement.workspace ?? "").trim().length;
			const [workspace, setWorkspace] = (0, react.useState)(props.requirement.workspace ?? "");
			const [mode, setMode] = (0, react.useState)("now");
			const [dueAtLocal, setDueAtLocal] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			const [submitting, setSubmitting] = (0, react.useState)(false);
			const listed = props.workspaces.some((w) => w.path === workspace);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: overlayStyle,
				onClick: props.onCancel,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: dialogStyle,
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
							style: { margin: "0 0 6px" },
							children: [
								"拆解任务：",
								props.requirement.id,
								" ",
								props.requirement.title
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: "#6b7280",
								marginBottom: 6
							},
							children: "拆解为默认五段式任务（分析 → 架构师拆解 → 开发 → 代码审核 → 测试）； 重新拆解会把已取消的任务原地重建为全新待办任务，在办/已完成任务跳过。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: fieldLabelStyle,
							children: ["工作目录", needWorkspace ? "（必填：拆解出的任务会继承，子 agent 据此定位代码库）" : "（由拆解出的任务继承）"]
						}),
						props.workspaces.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: {
								...fieldStyle,
								marginBottom: 6
							},
							value: listed ? workspace : "",
							onChange: (e) => setWorkspace(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "— 从 dsh 已添加的工作区选择 —"
							}), props.workspaces.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: w.path,
								children: [w.title, w.path ? `（${w.path}）` : ""]
							}, w.id))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: fieldStyle,
							placeholder: "绝对路径，如 D:\\\\code\\\\his",
							value: workspace,
							onChange: (e) => setWorkspace(e.target.value)
						}),
						needWorkspace && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#b45309",
								marginTop: 2
							},
							children: "该需求尚未设置工作目录：请先填写（下拉选或手填绝对路径），才能拆解。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "执行时机"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 16,
								alignItems: "center",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										fontSize: 13,
										cursor: "pointer"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										checked: mode === "now",
										onChange: () => setMode("now"),
										style: { marginRight: 4 }
									}), "立刻（默认）"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										fontSize: 13,
										cursor: "pointer"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										checked: mode === "at",
										onChange: () => setMode("at"),
										style: { marginRight: 4 }
									}), "定时"]
								}),
								mode === "at" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "datetime-local",
									style: {
										...fieldStyle,
										width: "auto"
									},
									value: dueAtLocal,
									onChange: (e) => setDueAtLocal(e.target.value)
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#6b7280",
								marginTop: 4
							},
							children: mode === "now" ? "拆解成功后主 agent 立即按依赖顺序编排子 Agent（上个任务完成才编排下个）。" : "到点后主 agent 自动开始编排（精确到分；定时条目落盘，插件重启后到点仍会执行）。"
						}),
						error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: "#dc2626",
								marginTop: 8
							},
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 14,
								display: "flex",
								gap: 8,
								justifyContent: "flex-end"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...buttonStyle$1,
									background: "#2563eb",
									color: "#fff",
									borderColor: "#2563eb"
								},
								disabled: props.busy || submitting,
								onClick: () => {
									setError("");
									setSubmitting(true);
									props.onConfirm({
										mode,
										dueAtLocal,
										workspace
									}).then((reason) => {
										if (reason) setError(reason);
									}).finally(() => setSubmitting(false));
								},
								children: submitting ? "处理中…" : "拆解"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: props.busy || submitting,
								onClick: props.onCancel,
								children: "取消"
							})]
						})
					]
				})
			});
		}
		/**
		* 任务编辑弹框（问题 4：拆解出的任务增加提示词、切换模型、选择技能/MCP）。
		*
		* 保存时带上 `expectedRevision`：宿主用乐观锁校验，冲突时返回可读原因
		* （"请刷新后重试"），不做自动覆盖（S-11）。
		*/
		function TaskEditDialog(props) {
			const t = props.task;
			const [prompt, setPrompt] = (0, react.useState)(t.prompt ?? "");
			const [workspace, setWorkspace] = (0, react.useState)(t.workspace ?? "");
			const [modelValue, setModelValue] = (0, react.useState)(t.frozenConfig.model ? t.frozenConfig.modelProvider ? modelOptionValue(t.frozenConfig.modelProvider, t.frozenConfig.model) : t.frozenConfig.model : "");
			const [skills, setSkills] = (0, react.useState)(t.frozenConfig.skills);
			const [mcp, setMcp] = (0, react.useState)(t.frozenConfig.mcp);
			const [workflow, setWorkflow] = (0, react.useState)(t.frozenConfig.workflow && t.frozenConfig.skills.includes(t.frozenConfig.workflow) ? t.frozenConfig.workflow : "");
			const [preset, setPreset] = (0, react.useState)(t.frozenConfig.preset ?? "");
			const [maxDepth, setMaxDepth] = (0, react.useState)(t.frozenConfig.maxDepth && t.frozenConfig.maxDepth > 0 ? String(t.frozenConfig.maxDepth) : "");
			const [maxTokens, setMaxTokens] = (0, react.useState)(t.frozenConfig.maxTokens && t.frozenConfig.maxTokens > 0 ? String(t.frozenConfig.maxTokens) : "");
			/** 模型按 provider 分组（spec 009：分组/去重复用 shared/model-route.ts）。 */
			const groupedModels = (0, react.useMemo)(() => groupModelOptions(props.modelOptions), [props.modelOptions]);
			/** 历史裸值兼容：残留裸 id 时追加一项，显式标注"未绑定供应商"。 */
			const legacyModel = modelValue && !parseModelOptionValue(modelValue) ? {
				value: modelValue,
				label: `${modelValue}（未绑定供应商，沿用会话供应商）`
			} : void 0;
			const modelRoute = decodeModelValue(modelValue);
			const listed = props.workspaces.some((w) => w.path === workspace);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: overlayStyle,
				onClick: props.onCancel,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: dialogStyle,
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
							style: { margin: "0 0 6px" },
							children: ["编辑任务：", t.title]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 12,
								color: "#6b7280"
							},
							children: [
								t.taskId,
								" ｜ revision ",
								t.revision,
								" ｜ 依赖 ",
								t.blockedBy.join("、") || "无"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "增加提示词（任务级；留空时派发用「需求提示词 + 标题/描述」）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							style: {
								...fieldStyle,
								minHeight: 110
							},
							placeholder: "例：只跑单元测试并给出失败用例清单；不要动 public API。",
							value: prompt,
							onChange: (e) => setPrompt(e.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "工作目录（该任务；不改变子代理进程 cwd）"
						}),
						props.workspaces.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: {
								...fieldStyle,
								marginBottom: 6
							},
							value: listed ? workspace : "",
							onChange: (e) => setWorkspace(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "— 从 dsh 已添加的工作区选择 —"
							}), props.workspaces.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: w.path,
								children: [w.title, w.path ? `（${w.path}）` : ""]
							}, w.id))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: fieldStyle,
							placeholder: "绝对路径；留空 = 清空",
							value: workspace,
							onChange: (e) => setWorkspace(e.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "模型（写进冻结配置；供应商与模型成对冻结，spec 009）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: fieldStyle,
							value: modelValue,
							onChange: (e) => setModelValue(e.target.value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "— 不指定（派发时取角色默认）—"
								}),
								legacyModel && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: legacyModel.value,
									children: legacyModel.label
								}),
								groupedModels.map((g) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("optgroup", {
									label: g.providerName,
									children: g.items.map((m) => {
										const v = modelOptionValue(m.provider, m.id);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: v,
											children: m.name || m.id
										}, v);
									})
								}, g.provider))
							]
						}),
						groupedModels.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#b45309",
								marginTop: 2
							},
							children: "宿主未返回模型清单（能力降级）：请到「执行配置」点「重新采集目录」。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "预设（preset；不指定 = 沿用角色 / 会话预设）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: fieldStyle,
							value: preset,
							onChange: (e) => setPreset(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "— 不指定 —"
							}), props.presets.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: p.id,
								disabled: !!p.broken,
								title: p.broken ?? p.description,
								children: [p.name, p.isDefault ? "（默认）" : ""]
							}, p.id))]
						}),
						props.presets.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#b45309",
								marginTop: 2
							},
							children: "宿主未返回预设清单（能力降级）：可到「执行配置」点「重新采集目录」。"
						}),
						props.skillGroups.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "技能/MCP 分组（选中自动带出组内技能与 MCP，可继续微调）"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: fieldStyle,
							value: "",
							onChange: (e) => {
								const gid = e.target.value;
								if (!gid) return;
								const g = props.skillGroups.find((x) => x.id === gid);
								if (!g) return;
								setSkills([...new Set(g.skills)]);
								setMcp([...new Set(g.mcp)]);
								setWorkflow((prev) => g.skills.includes(prev) ? prev : "");
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "— 选择分组带出技能/MCP —"
							}), props.skillGroups.map((g) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: g.id,
								children: [
									g.name,
									"（技能 ",
									g.skills.length,
									" · MCP ",
									g.mcp.length,
									"）"
								]
							}, g.id))]
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: fieldLabelStyle,
							children: [
								"技能（写进冻结配置，当前可选 ",
								dedupeOptions(props.skillOptions.map((s) => ({
									value: s.name,
									label: s.name
								}))).length,
								" 项）"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
							options: props.skillOptions.map((s) => ({
								value: s.name,
								label: s.name,
								hint: `${s.source}${s.modelInvocable ? " · 模型可调用" : ""}`
							})),
							value: skills,
							onChange: (next) => {
								setSkills(next);
								setWorkflow((prev) => next.includes(prev) ? prev : "");
							},
							placeholder: "未选择技能",
							searchPlaceholder: "按技能名刷选…"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "工作流（从全部已安装技能中选择；选中即强制按该技能的流程逐步执行，禁止跳步）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: fieldStyle,
							value: workflow,
							onChange: (e) => {
								const next = e.target.value;
								setWorkflow(next);
								if (next) setSkills((prev) => prev.includes(next) ? prev : [...prev, next]);
							},
							disabled: props.skillOptions.length === 0,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "— 不启用工作流（自由执行）—"
							}), props.skillOptions.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: s.name,
								children: [s.name, skills.includes(s.name) ? "（已在技能中）" : ""]
							}, s.name))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#9ca3af",
								marginTop: 2
							},
							children: props.skillOptions.length === 0 ? "宿主未返回技能清单：可到「执行配置」点「重新采集目录」。" : "选中后会自动加入「技能」：派发时读取该技能正文并解析步骤，要求子代理逐步输出「✅ 步骤 i/N」；跳步会被判为不达标。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: fieldLabelStyle,
							children: [
								"MCP（写进冻结配置，当前可选 ",
								props.mcpServers.length,
								" 项）"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MultiSelect, {
							options: props.mcpServers.map((m) => ({
								value: m,
								label: m
							})),
							value: mcp,
							onChange: setMcp,
							placeholder: "未选择 MCP",
							searchPlaceholder: "按 server 名刷选…"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							style: fieldLabelStyle,
							children: "执行预算（留空 = 不限制 / 沿用默认；用于抑制失控空转、降低 token）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 10,
								flexWrap: "wrap"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									fontSize: 12,
									color: "#4b5563"
								},
								children: ["最大委派深度\xA0", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 0,
									step: 1,
									style: {
										...fieldStyle,
										width: 110
									},
									placeholder: "如 1",
									value: maxDepth,
									onChange: (e) => setMaxDepth(e.target.value)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									fontSize: 12,
									color: "#4b5563"
								},
								children: ["单次最大输出 token\xA0", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 0,
									step: 1e3,
									style: {
										...fieldStyle,
										width: 150
									},
									placeholder: "如 20000",
									value: maxTokens,
									onChange: (e) => setMaxTokens(e.target.value)
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "#9ca3af",
								marginTop: 2
							},
							children: "深度限制子代理再委派的层数（0/空 = 不限）；输出 token 限制单次模型回复上限（0/空 = 不限）。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 14,
								display: "flex",
								gap: 8,
								justifyContent: "flex-end"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...buttonStyle$1,
									background: "#2563eb",
									color: "#fff",
									borderColor: "#2563eb"
								},
								disabled: props.busy,
								onClick: () => {
									const depthNum = Number(maxDepth);
									const tokensNum = Number(maxTokens);
									props.onSave({
										taskId: t.taskId,
										prompt: prompt.trim() || null,
										workspace: workspace.trim() || null,
										model: modelRoute?.id ?? "",
										modelProvider: modelRoute?.provider ?? "",
										skills,
										mcp,
										workflow: skills.includes(workflow) ? workflow : "",
										preset: preset.trim(),
										...maxDepth.trim() !== "" && Number.isFinite(depthNum) && depthNum >= 0 ? { maxDepth: Math.floor(depthNum) } : {},
										...maxTokens.trim() !== "" && Number.isFinite(tokensNum) && tokensNum >= 0 ? { maxTokens: Math.floor(tokensNum) } : {},
										expectedRevision: t.revision
									});
								},
								children: "保存"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: props.busy,
								onClick: props.onCancel,
								children: "取消"
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/components/ConnectionPanel.tsx
		const sectionStyle = {
			border: "1px solid #e5e7eb",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12,
			background: "#fff"
		};
		const inputStyle = {
			padding: "6px 8px",
			border: "1px solid #d1d5db",
			borderRadius: 6,
			fontSize: 13
		};
		const buttonStyle = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "1px solid #d1d5db",
			background: "#f3f4f6",
			cursor: "pointer",
			fontSize: 13
		};
		const primaryButtonStyle = {
			...buttonStyle,
			background: "#2563eb",
			borderColor: "#2563eb",
			color: "#fff"
		};
		const h4Style = {
			margin: "0 0 8px",
			fontSize: 14
		};
		const hintStyle = {
			fontSize: 12,
			color: "#6b7280"
		};
		/**
		* 连接与凭据面板。
		* @param props - 见 {@link ConnectionPanelProps}。
		*/
		function ConnectionPanel(props) {
			const [auditMsg, setAuditMsg] = (0, react.useState)(null);
			const [archiving, setArchiving] = (0, react.useState)(false);
			const [envMsg, setEnvMsg] = (0, react.useState)(null);
			const [copyMsg, setCopyMsg] = (0, react.useState)(null);
			const [profileMsg, setProfileMsg] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [editId, setEditId] = (0, react.useState)("");
			const [name, setName] = (0, react.useState)("");
			const [url, setUrl] = (0, react.useState)("");
			const [collection, setCollection] = (0, react.useState)("");
			const [pat, setPat] = (0, react.useState)("");
			const [toolQuery, setToolQuery] = (0, react.useState)("");
			const [toolCat, setToolCat] = (0, react.useState)("");
			const [showAdvanced, setShowAdvanced] = (0, react.useState)(false);
			/** 封装工具按分类分组 + 关键字筛选（问题 12）。 */
			const toolGroups = (0, react.useMemo)(() => {
				const tools = props.toolCatalog?.tools ?? [];
				const kw = toolQuery.trim().toLowerCase();
				const hit = tools.filter((t) => {
					if (toolCat && t.category !== toolCat) return false;
					if (!kw) return true;
					return [
						t.plugin,
						t.raw,
						t.title,
						t.description
					].some((s) => s.toLowerCase().includes(kw));
				});
				const groups = /* @__PURE__ */ new Map();
				for (const t of hit) {
					const g = groups.get(t.category) ?? {
						label: t.categoryLabel,
						items: []
					};
					g.items.push(t);
					groups.set(t.category, g);
				}
				return [...groups.entries()];
			}, [
				props.toolCatalog,
				toolQuery,
				toolCat
			]);
			const resetForm = () => {
				setEditId("");
				setName("");
				setUrl("");
				setCollection("");
				setPat("");
			};
			const submitProfile = async () => {
				setSaving(true);
				setProfileMsg(null);
				try {
					const input = {
						name,
						url,
						collection,
						...pat ? { pat } : {},
						...editId ? { id: editId } : {}
					};
					const res = await props.onSaveProfile(input);
					setProfileMsg(res.ok ? `已保存档案 ${res.profile?.id ?? ""}` : `保存失败：${res.reason ?? "未知原因"}`);
					if (res.ok) {
						resetForm();
						props.onProfilesRefresh();
						props.onMcpRefresh();
					}
				} finally {
					setSaving(false);
				}
			};
			const archive = async () => {
				setArchiving(true);
				setAuditMsg(null);
				try {
					const res = await props.onArchive();
					setAuditMsg(res.ok ? `已归档 ${res.archived ?? 0} 条${res.archivePath ? ` → ${res.archivePath}` : "（无过期条目，未创建文件）"}` : `归档失败：${res.reason ?? "未知原因"}`);
					props.onAuditRefresh();
				} finally {
					setArchiving(false);
				}
			};
			const copyTemplate = async () => {
				const text = (props.mcp?.template.posixLines ?? []).join("\n");
				try {
					await navigator.clipboard.writeText(text);
					setCopyMsg("已复制 POSIX 环境变量（含占位符，无明文 PAT）");
				} catch {
					setCopyMsg("复制失败（浏览器未授权剪贴板），请手动选中下方文本复制");
				}
			};
			const writeEnv = async () => {
				setEnvMsg(null);
				const res = await props.onWriteEnvFile();
				setEnvMsg(res.ok ? `已导出 ${res.path}（${res.bytes ?? 0} 字节${res.hardened ? "，权限 0600" : "；文件系统不支持收紧权限，请自行确认访问控制"}）。该文件含明文 PAT，仅用于凭据备份/迁移 —— 插件直连 REST，正常运行无需 source 它。` : `导出失败：${res.reason ?? "未知原因"}`);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontFamily: "system-ui, sans-serif",
					color: "#111827",
					maxWidth: 860
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: { margin: "0 0 12px" },
						children: "连接与凭据"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: sectionStyle,
						"aria-labelledby": "sec-health",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								id: "sec-health",
								style: h4Style,
								children: "连通性自检（T029）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									alignItems: "center",
									flexWrap: "wrap"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: primaryButtonStyle,
									onClick: props.onHealthCheck,
									children: "运行自检"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: hintStyle,
									children: [
										"只读调用 whoami / 当前集合 / 项目清单（直连 REST ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "/_apis/*" }),
										"），不触发任何写操作"
									]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								role: "status",
								"aria-live": "polite",
								style: { marginTop: 10 },
								children: [props.health === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: hintStyle,
									children: "尚未自检。"
								}), props.health !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										border: "1px solid #e5e7eb",
										borderLeft: `4px solid ${props.health.ok ? "#059669" : "#dc2626"}`,
										borderRadius: 8,
										padding: 12,
										fontSize: 13
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontWeight: 600,
												color: props.health.ok ? "#047857" : "#b91c1c"
											},
											children: props.health.ok ? "连通正常" : `连接失败（${props.health.kind ?? "unknown"}）`
										}),
										props.health.identity && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: { marginTop: 4 },
											children: ["身份：", props.health.identity]
										}),
										props.health.collection && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["当前集合：", props.health.collection] }),
										props.health.projectCount !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["可见项目：", props.health.projectCount] }),
										props.health.reason && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												marginTop: 4,
												color: "#7f1d1d"
											},
											children: props.health.reason
										}),
										props.health.tools && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: { marginTop: 8 },
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: { color: "#374151" },
												children: [
													"已接入 REST 的操作 ",
													props.health.tools.available.length,
													" 个"
												]
											}), props.health.tools.missing.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: {
													marginTop: 4,
													color: "#b45309"
												},
												children: ["契约表已登记、但尚未接入端点（能力缺口）：", props.health.tools.missing.join(", ")]
											})]
										})
									]
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: sectionStyle,
						"aria-labelledby": "sec-tools",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								id: "sec-tools",
								style: h4Style,
								children: "TFS 能力目录（REST 直连 → tfs_req_*）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									alignItems: "center",
									flexWrap: "wrap"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle,
									onClick: props.onToolCatalogRefresh ?? props.onMcpRefresh,
									children: "刷新能力目录"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: hintStyle,
									children: [props.toolCatalog ? `契约表登记 ${props.toolCatalog.rawCount} 个操作，已接入端点 ${props.toolCatalog.wrappedCount} 个` : "尚未读取能力目录", props.toolCatalog && props.toolCatalog.missingCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { color: "#b45309" },
										children: [
											" ｜ 另有 ",
											props.toolCatalog.missingCount,
											" 个尚未接入端点（能力缺口）"
										]
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 8,
									padding: 8,
									background: "#f8fafc",
									borderRadius: 6,
									fontSize: 12,
									color: "#374151"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "本插件不依赖任何 MCP：" }),
									"TFS 查询与操作一律",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "直连 REST" }),
									"（",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "/_apis/*" }),
									"），凭据由「连接档案」按调用实时提供 —— 改 PAT 当场生效，无需重启。 模型只会看到本插件注册的 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "tfs_req_*" }),
									" 工具；所有写操作走适配层单一出口， 过 dry-run / 确认 / 幂等 / 审计四道写门禁，不存在绕过路径。"
								]
							}),
							props.toolCatalog && !props.toolCatalog.ok && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 6,
									fontSize: 12,
									color: "#b45309"
								},
								children: props.toolCatalog.reason
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									marginTop: 8,
									flexWrap: "wrap",
									alignItems: "center"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "search",
										"aria-label": "按操作名刷选",
										style: inputStyle,
										placeholder: "按工具名 / 操作键 / 说明刷选…",
										value: toolQuery,
										onChange: (e) => setToolQuery(e.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										"aria-label": "按分类筛选",
										style: inputStyle,
										value: toolCat,
										onChange: (e) => setToolCat(e.target.value),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "全部分类"
										}), [...new Set((props.toolCatalog?.tools ?? []).map((t) => t.category))].map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: c,
											children: (props.toolCatalog?.tools ?? []).find((t) => t.category === c)?.categoryLabel ?? c
										}, c))]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: hintStyle,
										children: [toolGroups.reduce((n, [, g]) => n + g.items.length, 0), " 个"]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 8,
									maxHeight: 320,
									overflowY: "auto"
								},
								children: [toolGroups.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: hintStyle,
									children: "无匹配工具。"
								}), toolGroups.map(([cat, g]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { marginBottom: 10 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 12,
											fontWeight: 600,
											color: "#374151",
											marginBottom: 4
										},
										children: [
											g.label,
											"（",
											g.items.length,
											"）"
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
										style: {
											width: "100%",
											borderCollapse: "collapse",
											fontSize: 12
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: g.items.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: { borderTop: "1px solid #f1f5f9" },
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "4px 8px",
														whiteSpace: "nowrap"
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: t.plugin })
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "4px 8px",
														whiteSpace: "nowrap",
														color: "#6b7280"
													},
													children: t.raw
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
													style: {
														padding: "4px 8px",
														whiteSpace: "nowrap"
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																color: t.access === "write" ? "#b45309" : "#047857",
																border: `1px solid ${t.access === "write" ? "#fcd34d" : "#a7f3d0"}`,
																borderRadius: 10,
																padding: "1px 8px",
																fontSize: 11
															},
															children: t.access === "write" ? "写·过门禁" : "读"
														}),
														t.unregistered && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																color: "#b45309",
																marginLeft: 6
															},
															children: "未登记"
														}),
														t.unimplemented && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																color: "#b45309",
																marginLeft: 6
															},
															children: "端点未接入"
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "4px 8px",
														color: "#374151"
													},
													children: t.description
												})
											]
										}, t.plugin)) })
									})]
								}, cat))]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: sectionStyle,
						"aria-labelledby": "sec-mcp",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								id: "sec-mcp",
								style: h4Style,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									"aria-expanded": showAdvanced,
									onClick: () => setShowAdvanced((v) => !v),
									style: {
										border: "none",
										background: "transparent",
										cursor: "pointer",
										fontSize: 14,
										fontWeight: 600,
										padding: 0,
										color: "#111827"
									},
									children: [showAdvanced ? "▾" : "▸", " 高级：连接诊断与凭据导出（排障用）"]
								})
							}),
							showAdvanced && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: "#6b7280",
									marginBottom: 8
								},
								children: "仅当需要排查\"TFS 连不上 / 凭据从哪来\"时才看这里。正常使用时无需关心 —— 插件直连 REST，凭据从上面选中的连接档案实时读取。"
							}),
							showAdvanced && props.mcp === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: hintStyle,
								children: "尚未读取连接诊断。"
							}),
							showAdvanced && props.mcp !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: { fontSize: 13 },
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["连接状态：", props.mcp.instance.runtimeAddSupported && props.mcp.instance.serverNameValid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { color: "#047857" },
										children: "✓ 可运行期变更（直连 REST）"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { color: "#b91c1c" },
										children: "✗ 需检查连接档案"
									})] })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										marginTop: 8,
										padding: 8,
										background: "#ecfdf5",
										borderRadius: 6,
										fontSize: 12,
										color: "#065f46"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "连接方式：" }),
										" ",
										props.mcp.instance.runtimeAddReason
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										marginTop: 6,
										fontSize: 12,
										color: "#374151"
									},
									children: props.mcp.instance.duplicateRisk
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										marginTop: 6,
										fontSize: 12,
										color: "#374151"
									},
									children: props.mcp.instance.credentialPath
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { marginTop: 10 },
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 13,
												marginBottom: 4
											},
											children: "凭据导出模板（PAT 为占位符，用于备份/迁移）："
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
											tabIndex: 0,
											"aria-label": "TFS 凭据导出模板",
											style: {
												background: "#0f172a",
												color: "#e5e7eb",
												padding: 10,
												borderRadius: 6,
												fontSize: 12,
												overflowX: "auto",
												margin: 0
											},
											children: props.mcp.template.posixLines.join("\n")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												marginTop: 6,
												display: "flex",
												gap: 8,
												flexWrap: "wrap",
												alignItems: "center"
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: buttonStyle,
													onClick: () => void copyTemplate(),
													children: "复制（POSIX）"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: primaryButtonStyle,
													onClick: () => void writeEnv(),
													children: "导出凭据文件（含明文 PAT）"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: hintStyle,
													children: ["目标：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: props.mcp.template.envFilePath })]
												})
											]
										}),
										copyMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												...hintStyle,
												marginTop: 4
											},
											children: copyMsg
										}),
										envMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											role: "status",
											"aria-live": "polite",
											style: {
												marginTop: 4,
												fontSize: 12,
												color: "#047857"
											},
											children: envMsg
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												marginTop: 4,
												fontSize: 12,
												color: "#92400e"
											},
											children: props.mcp.template.note
										})
									]
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: sectionStyle,
						"aria-labelledby": "sec-profile",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								id: "sec-profile",
								style: h4Style,
								children: "连接档案（T031 / FR-002 / FR-031）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { fontSize: 13 },
								children: [
									props.profiles === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: hintStyle,
										children: "尚未加载档案。"
									}),
									props.profiles !== null && props.profiles.profiles.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: hintStyle,
										children: "暂无档案。填写下方表单新增（PAT 只进本地存储，不回显）。"
									}),
									props.profiles !== null && props.profiles.profiles.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
										style: {
											width: "100%",
											borderCollapse: "collapse",
											fontSize: 12
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: {
												textAlign: "left",
												color: "#6b7280"
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "6px 8px" },
													children: "名称"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "6px 8px" },
													children: "地址"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "6px 8px" },
													children: "集合"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: { padding: "6px 8px" } })
											]
										}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: props.profiles.profiles.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: {
													padding: "6px 8px",
													borderTop: "1px solid #f1f5f9"
												},
												children: [p.name, props.profiles?.activeId === p.id && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: {
														marginLeft: 6,
														color: "#047857",
														fontSize: 11
													},
													children: "（当前使用）"
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													padding: "6px 8px",
													borderTop: "1px solid #f1f5f9"
												},
												children: p.url
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													padding: "6px 8px",
													borderTop: "1px solid #f1f5f9"
												},
												children: p.collection
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
												style: {
													padding: "6px 8px",
													borderTop: "1px solid #f1f5f9",
													whiteSpace: "nowrap"
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: {
															...buttonStyle,
															marginRight: 6
														},
														onClick: () => {
															setEditId(p.id);
															setName(p.name);
															setUrl(p.url);
															setCollection(p.collection);
															setPat("");
														},
														children: "编辑"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: {
															...buttonStyle,
															marginRight: 6
														},
														onClick: () => {
															props.onActivateProfile(p.id).then((r) => {
																setProfileMsg(r.ok ? `已切换为「${r.profile?.name ?? p.id}」` : `切换失败：${r.reason}`);
																props.onProfilesRefresh();
															});
														},
														children: "设为当前"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: buttonStyle,
														onClick: () => {
															props.onDeleteProfile(p.id).then((r) => {
																setProfileMsg(r.ok ? "已删除（存储已随机字节覆写 S-12）" : `删除失败：${r.reason}`);
																props.onProfilesRefresh();
															});
														},
														children: "删除"
													})
												]
											})
										] }, p.id)) })]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 12,
									display: "grid",
									gap: 10
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "pf-name",
										style: {
											...hintStyle,
											display: "block",
											marginBottom: 4
										},
										children: "名称"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "pf-name",
										style: {
											...inputStyle,
											width: "100%",
											boxSizing: "border-box"
										},
										value: name,
										onChange: (e) => setName(e.target.value)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "pf-url",
										style: {
											...hintStyle,
											display: "block",
											marginBottom: 4
										},
										children: "地址"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "pf-url",
										style: {
											...inputStyle,
											width: "100%",
											boxSizing: "border-box"
										},
										placeholder: "http://tfs2018-web.winning.com.cn:8080/tfs",
										value: url,
										onChange: (e) => setUrl(e.target.value)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "pf-col",
										style: {
											...hintStyle,
											display: "block",
											marginBottom: 4
										},
										children: "集合"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "pf-col",
										style: {
											...inputStyle,
											width: "100%",
											boxSizing: "border-box"
										},
										value: collection,
										onChange: (e) => setCollection(e.target.value)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "pf-pat",
										style: {
											...hintStyle,
											display: "block",
											marginBottom: 4
										},
										children: "PAT（保存后永不回显）"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "pf-pat",
										type: "password",
										style: {
											...inputStyle,
											width: "100%",
											boxSizing: "border-box"
										},
										placeholder: editId ? "留空=沿用原 PAT" : "必填",
										value: pat,
										autoComplete: "off",
										onChange: (e) => setPat(e.target.value)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											gap: 8
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: primaryButtonStyle,
											disabled: saving,
											onClick: () => void submitProfile(),
											children: saving ? "保存中…" : editId ? "保存修改" : "新增档案"
										}), editId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											onClick: resetForm,
											children: "取消编辑"
										})]
									})
								]
							}),
							profileMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "status",
								"aria-live": "polite",
								style: {
									marginTop: 6,
									fontSize: 12,
									color: "#374151"
								},
								children: profileMsg
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: sectionStyle,
						"aria-labelledby": "sec-audit",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								id: "sec-audit",
								style: h4Style,
								children: "审计与归档（T063 / S-03）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									alignItems: "center",
									flexWrap: "wrap"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										onClick: props.onAuditRefresh,
										children: "刷新审计状态"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: primaryButtonStyle,
										disabled: archiving,
										onClick: () => void archive(),
										children: archiving ? "归档中…" : "归档过期条目"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: hintStyle,
										children: [
											"归档只",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "读" }),
											" live 日志、把过期条目写入独立文件，审计日志保持 append-only"
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								role: "status",
								"aria-live": "polite",
								style: {
									marginTop: 8,
									fontSize: 13
								},
								children: [
									props.audit === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: hintStyle,
										children: "尚未读取审计状态。"
									}),
									props.audit !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										!props.audit.ok && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: { color: "#b91c1c" },
											children: ["读取失败：", props.audit.reason]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
											"保留期 ",
											props.audit.retentionDays,
											" 天 ｜ 条目总数 ",
											props.audit.total,
											" ｜ 待归档 ",
											props.audit.expired
										] }),
										props.audit.archiveFiles.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: { marginTop: 4 },
											children: ["归档文件：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
												style: {
													margin: "4px 0 0 18px",
													padding: 0
												},
												children: props.audit.archiveFiles.map((f) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: f.name }),
													"（",
													f.bytes,
													" 字节）"
												] }, f.name))
											})]
										})
									] }),
									auditMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											marginTop: 6,
											color: auditMsg.startsWith("归档失败") ? "#b91c1c" : "#047857"
										},
										children: auditMsg
									})
								]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/shared/contracts.ts
		/**
		* 客户端半 → 宿主半的 HTTP 路由路径（Phase 3 真实通道，对齐 dsh-optimized-prompt 的
		* `/optimized-prompt/*` 模式：客户端 `fetch` → 宿主 `webServer.register`）。路径为编译期常量，
		* 两侧必须一致；放在共享契约里避免两端各写一份、配置一改就分家。
		*/
		const TFS_ROUTES = {
			/** GET 取面板静态数据。 */
			panelData: "/tfs-requirment/panel-data",
			/** POST 确认回写（tag/comment/state）。 */
			confirmWrite: "/tfs-requirment/confirm-write",
			/** POST 发起执行（按角色派发 subagent）。 */
			dispatch: "/tfs-requirment/dispatch",
			/**
			* POST 需求池列表（US2）。
			*
			* 用 POST 而非 GET：筛选条件含 projects/types/states/assignedTo 等数组与关键字，放在 query
			* string 上易超长且需重复转义；请求体承载 {@link RequirementFilter}，返回 {@link RequirementListResult}。
			*/
			requirements: "/tfs-requirment/requirements",
			/** GET 需求筛选可选项（问题 3：项目/类型/状态/指派人；命中宿主进程内缓存则不重采）。 */
			queryOptions: "/tfs-requirment/query-options",
			/**
			* POST 强制重采需求筛选可选项（绕过缓存）。
			*
			* 用 POST 而非 GET：它有**副作用**（丢弃缓存并重新拉取 TFS 元数据），
			* 放在 GET 上会让任何预取/重试链路意外触发整轮元数据采集。
			*/
			queryOptionsRefresh: "/tfs-requirment/query-options-refresh",
			/** GET 角色清单（US5）。 */
			roles: "/tfs-requirment/roles",
			/** POST 保存/更新角色（US5）。 */
			roleSave: "/tfs-requirment/role-save",
			/** POST 删除角色（US5；被引用时需 force）。 */
			roleDelete: "/tfs-requirment/role-delete",
			/** GET 技能/MCP 分组清单（2026-11-03 用户诉求）。 */
			skillGroups: "/tfs-requirment/skill-groups",
			/** POST 保存/更新技能/MCP 分组。 */
			skillGroupSave: "/tfs-requirment/skill-group-save",
			/** POST 删除技能/MCP 分组。 */
			skillGroupDelete: "/tfs-requirment/skill-group-delete",
			/** GET 看板快照（US3 任务中心 / US6 恢复）。 */
			board: "/tfs-requirment/board",
			/** POST 领取需求入本地池（US2 / T036）+ 打 dsh 标签（T048）。 */
			claim: "/tfs-requirment/claim",
			/** POST 拆解需求为任务（US3 / T041）。 */
			decompose: "/tfs-requirment/decompose",
			/** POST 指派任务角色（US3 / T042）。 */
			taskAssign: "/tfs-requirment/task-assign",
			/** POST 任务状态操作 启动/完成/重试/取消（US3 / T043）。 */
			taskState: "/tfs-requirment/task-state",
			/** GET 连通性自检（US1 / T029 测试连接）。 */
			health: "/tfs-requirment/health",
			/** GET 审计状态（T063）。 */
			audit: "/tfs-requirment/audit",
			/** POST 执行审计滚动归档（T063）。 */
			auditArchive: "/tfs-requirment/audit-archive",
			/** POST 切换默认集合（T030 / FR-003）。 */
			collection: "/tfs-requirment/collection",
			/** GET 连接档案清单（T031；不含 PAT）。 */
			profiles: "/tfs-requirment/profiles",
			/** POST 保存/更新连接档案（T031）。 */
			profileSave: "/tfs-requirment/profile-save",
			/** POST 删除连接档案（T031）。 */
			profileDelete: "/tfs-requirment/profile-delete",
			/** POST 设为活动档案（T031）。 */
			profileActivate: "/tfs-requirment/profile-activate",
			/** GET MCP 接入模板 + 实例诊断（T028b）。 */
			mcpInstance: "/tfs-requirment/mcp-instance",
			/** POST 写出 MCP 启动环境文件（T028b）。 */
			mcpEnvFile: "/tfs-requirment/mcp-env-file",
			/** GET 本插件的能力目录（问题 8 / 12）。 */
			tfsTools: "/tfs-requirment/tfs-tools",
			/**
			* POST 强制重采 DSH 能力目录（模型 / 技能 / 预设 / 工作区 / provider / MCP）。
			*
			* 存在的理由：目录在 `apply` 期只采一次，而用户可能**先打开插件、后配置模型**
			* （如新增 provider key、装新技能、加新 MCP server）。没有这条路由，UI 拿到的永远是
			* 首次采集的空/旧快照 —— 表现为"下拉里没有我刚配的模型"，且用户无法自救。
			* 该路由让"执行配置"标签页的刷新按钮真正触发重采，而不是只重读同一份内存快照。
			*/
			catalogRefresh: "/tfs-requirment/catalog-refresh",
			/** GET 读本地落盘的需求池可选项（问题 1；无缓存返回 data:null）。 */
			queryOptionsLoad: "/tfs-requirment/query-options-load",
			/** POST 强制重采需求池可选项并落盘覆盖（问题 1「采集可选项」）。 */
			queryOptionsCollect: "/tfs-requirment/query-options-collect",
			/** GET/POST UI 状态（筛选/每页条数，问题 2/4/6）。 */
			uiState: "/tfs-requirment/ui-state",
			/** POST 还原已领取需求回需求池（问题 7）。 */
			requirementRestore: "/tfs-requirment/requirement-restore",
			/** POST 实时重取需求四段描述并回写看板（问题 11）。 */
			requirementEnrich: "/tfs-requirment/requirement-enrich",
			/** POST 删除已取消任务（问题 8，批量）。 */
			taskDelete: "/tfs-requirment/task-delete",
			/** POST 编辑已领取需求本地字段（问题 3：提示词 / 工作目录）。 */
			requirementUpdate: "/tfs-requirment/requirement-update",
			/** POST 设置需求级执行状态（问题 5：确认完成 / 取消完成）。 */
			requirementExecState: "/tfs-requirment/requirement-exec-state",
			/** POST 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录）。 */
			taskUpdate: "/tfs-requirment/task-update",
			/** GET 任务执行过程轨迹（spec 006 US2；query：taskId、attempt?）。 */
			taskTrace: "/tfs-requirment/task-trace",
			/** POST 对任务追问 / 补充指令（spec 006 US3；body：FollowUpTaskInput）。 */
			taskFollowUp: "/tfs-requirment/task-follow-up",
			/**
			* POST 需求完成自动回写（问题 4；body：{ requirementKey, force? }）。
			*
			* 全部任务完成时宿主会自动调用一次；此路由用于：① 自动回写关闭时的"手动回写"入口；
			* ② 部分失败后的"重新回写"（幂等，已成功的项跳过）。GET（query requirementKey）只读回写报告。
			*/
			requirementWriteBack: "/tfs-requirment/requirement-write-back",
			/**
			* POST 确保需求有编排主 agent 会话（spec 010 US1；body：{ requirementKey }）。
			*
			* 幂等：已存在 continuable 编排会话时直接返回既有上下文，不重复创建。
			* provider 不支持 / 宿主不可用 ⇒ 返回 `mode:'off'` + 可读 `reason`（fail-loud，不静默）。
			*/
			orchestratorEnsure: "/tfs-requirment/orchestrator-ensure",
			/**
			* POST 开始编排（2026-11-03 问题 4/5）。
			* body：{ requirementKey, mode: 'now' | 'at', dueAt?, sequential? }。
			* 'at' = 登记定时（精确到分，持久化 + 重启补跑）；'now' = 立刻按依赖顺序启动子 Agent 链。
			*/
			orchestrationStart: "/tfs-requirment/orchestration-start",
			/** GET 定时执行条目清单（问题 4/5）。 */
			schedules: "/tfs-requirment/schedules",
			/** POST 取消一条定时执行（body：{ id }）。 */
			scheduleCancel: "/tfs-requirment/schedule-cancel",
			/** POST 修改定时执行的到点时刻（body：{ id, dueAt }，2026-11-03 问题 3）。 */
			scheduleUpdate: "/tfs-requirment/schedule-update"
		};
		//#endregion
		//#region src/shared/batch-dispatch.ts
		/** 任务是否已到"不需要再推进"的终态。 */
		function isSettled(t) {
			return t.state === "completed" || t.state === "deleted";
		}
		/**
		* 对选中集合做一次分波判定。
		*
		* @param tasks - **全量**任务快照（依赖任务可能不在选中集合内，故不能只传选中的）。
		* @param selected - 本次批量派发选中的任务 id。
		* @returns 分波结果（五个桶互斥且并集 = `selected` 去重后的集合）。
		*/
		function planBatchStep(tasks, selected) {
			const byId = /* @__PURE__ */ new Map();
			for (const t of tasks) byId.set(t.taskId, t);
			const step = {
				done: [],
				running: [],
				ready: [],
				waiting: [],
				stuck: []
			};
			for (const id of [...new Set(selected)]) {
				const t = byId.get(id);
				if (!t) {
					step.stuck.push({
						taskId: id,
						reason: "任务不存在（可能已被删除，请刷新后重新勾选）"
					});
					continue;
				}
				if (isSettled(t)) {
					step.done.push(id);
					continue;
				}
				const missing = [];
				const cancelled = [];
				const unmet = [];
				for (const depId of t.blockedBy) {
					const dep = byId.get(depId);
					if (!dep) missing.push(depId);
					else if (dep.state === "deleted") cancelled.push(depId);
					else if (dep.state !== "completed") unmet.push(depId);
				}
				if (missing.length > 0) {
					step.stuck.push({
						taskId: id,
						reason: `依赖任务不存在：${missing.join("、")}`
					});
					continue;
				}
				if (cancelled.length > 0) {
					step.stuck.push({
						taskId: id,
						reason: `依赖任务已取消，永远不会完成：${cancelled.join("、")}`
					});
					continue;
				}
				if (t.state === "in_progress") {
					if (t.execState === "running" || t.execState === "success") {
						step.running.push(id);
						continue;
					}
					if (unmet.length === 0) step.ready.push(id);
					else step.waiting.push(id);
					continue;
				}
				if (unmet.length === 0) step.ready.push(id);
				else step.waiting.push(id);
			}
			return step;
		}
		//#endregion
		//#region src/shared/panel-open-control.ts
		/**
		* 面板「开 / 关」状态的共享控制器（纯逻辑，无 DOM / React 依赖）。
		*
		* ## 为什么需要它
		*
		* 在较旧 / 精简的宿主（无 `main` 中央槽与 `sidebar.panellist` 菜单槽，只有
		* `sidebar.footer.action` 入口槽与 `shell.overlay` 浮层槽）上，TFS 面板的
		* **入口按钮**（footer.action）与**全屏面板本体**（shell.overlay）是两个
		* 不同槽里的独立组件，彼此不能直接传 props。本控制器作为模块级单例，
		* 让入口按钮 `show()`、面板本体订阅状态并在打开时渲染、`hide()` 时卸载，
		* 从而既复用 shell.overlay（全屏覆盖）又不会"开机即盖住应用"
		* （shell.overlay 是常驻 list 槽，组件默认 getSnapshot()===false ⇒ 返回 null）。
		*
		* API 形状对齐 React `useSyncExternalStore`：`subscribe` / `getSnapshot`，
		* 客户端半直接 `useSyncExternalStore(control.subscribe, control.getSnapshot)`。
		*
		* @module @deepseek-ai/dsh-tfs-requirment/shared/panel-open-control
		*/
		var PanelOpenControl = class {
			open = false;
			listeners = /* @__PURE__ */ new Set();
			/** 当前是否打开（稳定返回同一布尔值，供 getSnapshot 避免无限重渲染）。 */
			getSnapshot = () => this.open;
			/**
			* 订阅开关变化。
			* @param fn 状态变化回调。
			* @returns 退订函数（幂等，重复调用安全）。
			*/
			subscribe = (fn) => {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			};
			/** 打开面板（已打开时为 no-op，不产生多余通知）。 */
			show() {
				if (this.open) return;
				this.open = true;
				this.emit();
			}
			/** 关闭面板（已关闭时为 no-op）。 */
			hide() {
				if (!this.open) return;
				this.open = false;
				this.emit();
			}
			emit() {
				for (const fn of [...this.listeners]) fn();
			}
		};
		//#endregion
		//#region src/client/takeover.ts
		/**
		* 与 DOM 接管型家族面板（`@linxin666/dsh-client-ui-task-board`、`@linxin666/dsh-ssh`）
		* 共存的互斥协议（问题 1：切到其他看板后 TFS 看板无法重新显示）。
		*
		* ## 背景（均有源码依据）
		*
		* 这两个面板不走宿主 `main` 槽，而是在 DOM 层接管中央列：
		*   - 打开时在 `<html>` 置 `data-dsh-taskboard-active` / `data-dsh-ssh-active`；
		*   - 向 `[class*='centerCol']` append 自己的 `[data-dsh-*-view]` 容器；
		*   - 用 CSS 隐藏中央列其余直接子节点（含宿主 MainPanel 与本插件 Workbench）：
		*       html[data-dsh-taskboard-active] [class*='centerCol']
		*         > :not([data-dsh-taskboard-view]) { display: none !important; }
		*   - 只在两种情况下关闭（panel-mount-core.ts）：
		*       ① capture 阶段点击会话/项目/搜索/新建会话行（选择器不含 sidebar.panellist 面板行）；
		*       ② 收到全局 `dsh-panel-activate` 事件且 detail 为兄弟面板名
		*         （任务看板认 'ssh'，SSH 面板认 'taskboard'）。
		*
		* 本插件的面板行走宿主槽位系统，两者都不满足，故必须在自己被激活时主动"驱逐"接管面板，
		* 否则 React 树里 Workbench 已挂载/已切换，却被 `display:none !important` 永久隐藏，
		* 表现为"点其他看板后再点 TFS 看板无效"。
		*
		* ## 为什么不会误开对方
		*
		* 面板只在"自己的侧边栏行被点击"时打开；它们的 onOtherActivate 只 close 不 open，
		* 且对自身同名 detail 直接忽略。故派发兄弟名事件只会让开着的一方关闭。
		*
		* 本文件为纯 DOM 工具，不依赖 React/cordis，便于在 jsdom 下单测。
		*/
		/** 跨插件激活事件名（与 task-board/ssh 的 panel-mount-core 常量一致）。 */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const TASKBOARD_ACTIVE_ATTR = "data-dsh-taskboard-active";
		const SSH_ACTIVE_ATTR = "data-dsh-ssh-active";
		/** 本插件 panellist 图标根节点上的钩子属性（见 slots.tsx 的 TfsPanelIcon）。 */
		const PANEL_ROW_HOOK = "data-tfs-panel-row";
		/** 本插件在跨插件协议中的面板名（现有两个面板忽略未知 detail，无副作用；供未来面板识别）。 */
		const PANEL_NAME = "tfs-requirment";
		/**
		* 让任务看板 / SSH 面板让位，确保宿主 `main` 槽（本看板）可见。
		*
		* 顺序：先走对方已发布的事件协议（其控制器自行 close，状态同步、容器按其自身逻辑隐藏），
		* 再兜底移除 `<html>` 激活属性（对方插件未安装/旧版本未消费事件时，CSS 隐藏规则同样失效）。
		*
		* @param broadcast - 是否广播自身激活事件；重复触发（如挂载+点击同帧）时可传 false。
		*/
		function evictTakeoverPanels(broadcast = true) {
			try {
				const html = document.documentElement;
				if (html.hasAttribute(TASKBOARD_ACTIVE_ATTR)) document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: "ssh" }));
				if (html.hasAttribute(SSH_ACTIVE_ATTR)) document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: "taskboard" }));
				html.removeAttribute(TASKBOARD_ACTIVE_ATTR);
				html.removeAttribute(SSH_ACTIVE_ATTR);
				if (broadcast) document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
			} catch (e) {
				console.warn("[tfs-requirment] 驱逐接管面板失败", e);
			}
		}
		/**
		* capture 阶段监听本插件 panellist 行点击。
		*
		* 不能只靠 Workbench 挂载 effect：TFS 已打开过（Workbench 已挂载但被接管面板隐藏）时，
		* 再点本行不会 remount，挂载 effect 不会触发——所以必须在点击链路上再挂一道。
		*
		* @returns dispose 函数（调用方负责挂到 ctx.effect / useEffect cleanup）。
		*/
		function bindPanelRowEviction() {
			const onClick = (event) => {
				const el = event.target;
				if (!el || typeof el.closest !== "function") return;
				const rowButton = el.closest("button,a,[role=\"button\"]");
				if (el.closest(`[data-tfs-panel-row]`) || rowButton?.querySelector(`[data-tfs-panel-row]`)) evictTakeoverPanels();
			};
			document.addEventListener("click", onClick, true);
			return () => document.removeEventListener("click", onClick, true);
		}
		//#endregion
		//#region src/shared/slot-registration.ts
		/**
		* 幂等注册：把「同一槽 + 同一 key」的重复注册变成**安全 no-op**。
		*
		* ## 它防的是什么（问题 1 的真正根因，2026-09-19 由宿主源码坐实）
		*
		* `main` 是 **keyed** 槽（`ui-layout/src/client/index.ts:153`），而宿主的
		* `SlotCore.register` 对**同 key 同 priority** 的第二次注册**直接抛错**
		* （`ui-slots/src/index.ts:844-851`）：
		*
		* ```
		* keyed slot "main" already has an entry for key "tfs-requirment" at priority 0
		*   — register at a different priority to shadow it (lowest renders)
		* ```
		*
		* 这条错误一旦从 `slots.inject` 的 callback 里抛出，后果是**永久性**的：
		* `SlotRegistry.inject` 的 `changed()` 捕获异常后调用 `stop()`
		* （`ui-renderer/src/client/registry.ts:210-222`），而 `stop()` 的注释写得明白 ——
		* *"Failure callers retire the injection permanently: a delayed setup failure
		* never retries on a later declaration."*（同文件 `:180-190`）
		*
		* ⇒ **一次重复注册 = 这份注入被永久注销**。此后菜单行可能还在（它在另一个槽里），
		*   但 `main` 槽里再也没有本插件的 entry ⇒ 宿主
		*   `LayoutController.selectPanel(id)` 的 `hasMainPanel(id)` 恒 false ⇒
		*   **点几次都没反应，看不见 TFS 看板**（用户报告的问题 1）；
		*   同时 `retainMainPanels`（`ui-layout/stores.ts:97-100`）把 `activePanelId` 置 null ⇒
		*   **关闭后再也开不出来**（与问题 2 的表现耦合）。
		*
		* ## 为什么会重复注册
		*
		* `inject` 的 callback 在**每次槽声明生命周期开始**时都会重新执行
		* （`registry.ts:192-208` 的 `reconcile` 按 `declarationEpoch` 判定）。
		* `main` 由 `ui-layout` 的 `root` 注册声明；`ui-layout` 的 `ctx.effect`
		* 一旦重跑（构建 / HMR / 布局重挂），`main` 的 `declarationEpoch` 就 +1，
		* 于是本插件的 callback 被再次调用 —— 若此时旧 entry 尚未释放，第二次
		* `register` 便撞上"已存在同 key"并抛错，注入随即被永久注销。
		*
		* ## 修法
		*
		* 注册前先探测该 key 是否已被占用；已占用就**直接返回**（复用既有 entry，
		* 不抛错、不注销）。这样无论 callback 被重跑多少次都收敛到"恰好一份"。
		*
		* ### 「先查后写」的竞态在此不成立
		*
		* 探测与注册都在**同一个同步块**内完成，而 `SlotCore.register` 是同步的 ——
		* JS 单线程下二者之间不可能插入别的注册，故不存在 TOCTOU 窗口。
		*
		* @param slots - 宿主 `ctx.slots` 服务（或其等价结构面）。
		* @param spec - 注册规约（`name` 必填；list 槽给 `id`，keyed 槽给 `key`）。
		* @param component - 该槽位的组件。
		* @returns 本次注册的注销函数（cordis effect 合法 disposer）；该 cell 已被
		*   占用、本次跳过时返回 `undefined`。**绝不能返回布尔值** —— 本函数的返回
		*   值直接作为 `slots.inject(key, () => registerOnce(...))` 的 effect 返回值，
		*   而 cordis 只接受 function/null/undefined/thenable/iterable；2026-09-26
		*   实测旧版返回 true/false 每次启动必抛 `TypeError: Invalid effect`
		*   （key=main / sidebar.panellist），并打断声明周期、连锁引发启动早期
		*   React #130。
		*/
		function registerOnce(slots, spec, component) {
			const cellKey = spec.key ?? spec.id;
			const probe = slots.entriesOfSlot;
			if (cellKey !== void 0 && typeof probe === "function") try {
				if (probe.call(slots, spec.name).some((entry) => {
					const options = entry.options;
					if (options === void 0) return false;
					return (spec.key !== void 0 ? options.key : options.id) === cellKey;
				})) return void 0;
			} catch {}
			const disposer = slots.register(spec, component);
			return typeof disposer === "function" ? disposer : void 0;
		}
		//#endregion
		//#region src/client/slots.tsx
		/**
		* 客户端半槽位接线（T047 / T034 / T055）+ 真实 HostBridge（Phase 3）。
		*
		* 「TFS 看板」有两种承载形态，共用同一份数据与同一个 `ExecutionPanel`：
		*
		*   1. **中央看板**（全流程）——需求池 / 任务中心 / 执行配置 / 角色管理 / 连接与凭据五个标签页：
		*      - `sidebar.panellist` 左侧菜单行（只画图标，宿主拥有行样式/文案/点击）；
		*      - `main` 中央面板，`key` 与菜单行的 `id` 同为 `PANEL_ID`。
		*   2. **右侧栏「TFS 执行」标签页**（与对话并排，优化项 R1）——
		*      - `ctx.sidebarRightTabs.register(...)` 声明页类型；
		*      - `sidebar.right.pane.tab` 槽渲染页体（key 同为该类型 id）。
		*
		* 早期版本注册在 `shell.overlay`（`kind:'list'` 的**常驻**浮层，宿主会一直渲染其中每个 entry），
		* 于是把全屏面板放进去 = 打开 dsh 就弹框盖住应用。改成 `main` 槽后由用户点菜单才挂载。
		*
		* 五个标签页由**单一面板条目**承载而非五个条目：`main` 是 keyed 槽，同 key 会互相顶掉。
		*
		* **客户端半 / 宿主半边界（重要，不臆造）**：客户端半是独立打包的，不能直接访问宿主服务
		* （如 `ctx.subagents.start`；工具经 `ToolRuntime.execute` 调用，**不是**服务上的可调用属性）。
		* 所有动作经 `HostBridge` 用 `fetch` 打到宿主半的 HTTP 路由
		* （路径见 `TFS_ROUTES`，实现见 `src/host/route.ts`）。
		*
		* @module @deepseek-ai/dsh-tfs-requirment/client/slots
		*/
		/**
		* spec 010：任务中心右侧「主对话框」的子槽键。
		*
		* 命名带插件前缀，避免与宿主/其它插件的槽键撞名（子槽键是全局命名空间，
		* 只能被一个父条目声明）。
		*/
		const TFS_CHAT_SLOT_KEY = "tfs.orchestrator.chat";
		/**
		* 「左侧菜单行是否已注册成功」的控制器（2026-10-08 修：菜单里出现两次「TFS 看板」）。
		*
		* ## 事实（本机 DOM 实测，非推断）
		*
		* 侧边栏里确实存在**两个** TFS 入口：
		*   - `sidebar.panellist` 的菜单行（top≈400），宿主 `SidebarRoot.tsx:71` 渲染，带文案；
		*   - `sidebar.footer.action` 的兼容入口按钮（top≈622），宿主 `SidebarRoot.tsx:307`
		*     渲染在 `footArea` 里 —— 位置恰好在第三方「今日用量」卡片（top≈582-618）**下方**，
		*     正是用户报告要取消的那一个。
		*
		* ## 为什么会有两个（源码依据）
		*
		* footer/overlay 这对入口是给**旧 / 精简宿主**（没有 `main` 与 `sidebar.panellist`，
		* 只有 `sidebar.footer.action` + `shell.overlay`）准备的兼容通道。当时的注释写着
		* "在新版宿主（用 main / panellist）上这两条不触发"——依据是"`slots.inject` 仅在该槽
		* **已被宿主声明时**才执行回调"。
		*
		* 这条依据是**错的**：`ui-sidebar` 在新版宿主里**同样声明了** `sidebar.footer.action`
		* （`packages/client/ui-sidebar/src/client/contract/slots.ts` 的 `SlotMap` 有该键，
		* 且 `SidebarRoot.tsx:307` 无条件 `renderSlot` 它），并且 `shell.overlay` 也照旧存在。
		* 于是两条"兼容"注入在新版宿主上**照常跑**，菜单行之外多出一个 footer 入口 ——
		* 两个入口点开还是同一个 Workbench，纯属重复。
		*
		* ## 修法
		*
		* 不去猜宿主版本，而是**看菜单行到底注册上了没有**：
		*   - 菜单行注册成功 ⇒ 用户已有一条正规入口 ⇒ footer 入口不再需要，不注册；
		*   - 菜单行未注册（旧宿主确实没有 panellist 槽）⇒ 保留 footer 入口作为唯一入口。
		*
		* 直接用 `PanelOpenControl` 复用其订阅语义：它的 `getSnapshot` 返回稳定布尔值，
		* 配合 `useSyncExternalStore` 不会触发无限重渲染（见该类的文档）。
		*
		* ## 为什么还需要 subscribe
		*
		* `slots.inject('sidebar.footer.action', ...)` 的回调可能**早于**
		* `sidebar.panellist` 的注册完成（两者声明顺序由宿主的注册顺序决定，不在本插件控制内）。
		* 那一刻探测结果还是 false，若就此定下"注册 footer 入口"，又会回到两个入口。
		* 故订阅 panellist 的注册变化：菜单行一出现就把开关翻到 true，footer 组件随即返回 null。
		*/
		const panelRowRegistered = new PanelOpenControl();
		/**
		* 启动对 `sidebar.panellist` 的观测，把「菜单行是否已注册」同步进 {@link panelRowRegistered}。
		*
		* 同步探测一次作为初值；能拿到 `subscribe` 时再订阅后续变化。
		* 任何一步失败都退化为"当前快照即结论"——最坏结果是保留 footer 入口（回到修复前的状态），
		* 不会出现入口消失（那才是真的功能丢失）。
		*
		* @param slots - 宿主 `ctx.slots`。
		* @returns dispose（交给 `ctx.effect`，随插件卸载一并退订）。
		*/
		function watchPanelRow(slots) {
			const sync = () => {
				try {
					const probe = slots.entriesOfSlot;
					if (typeof probe !== "function") return;
					if (probe.call(slots, "sidebar.panellist").some((entry) => entry.options?.id === PANEL_ID)) panelRowRegistered.show();
				} catch {}
			};
			sync();
			try {
				if (typeof slots.subscribe !== "function") return () => {};
				return slots.subscribe("sidebar.panellist", sync);
			} catch {
				return () => {};
			}
		}
		/**
		* 本插件面板的唯一 id。
		*
		* 它**同时**是两处的键，二者必须同名：
		*   - `sidebar.panellist` 的 entry id（左侧菜单行）；
		*   - `main` 槽的 key（中央面板）。
		*
		* 依据（宿主源码，逐条核实）：
		*   - 侧边栏行的点击动作就是 `selectPanel(id)`：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:68`；
		*   - 中央面板按该 id 派发：`packages/client/ui-layout/src/client/index.ts` 的 `MainPanel` →
		*     `renderSlot('main', {}, { entryKey: usePanelInfo(info => info.activePanelId) ?? 'conversation' })`；
		*   - `layout.selectPanel` 只接受**已注册**的 main key，否则抛错：`ui-layout/src/client/service.ts:67-74`。
		* 名字对不上的后果是"点了菜单没反应"，故用同一常量而非两处字面量。
		*/
		const PANEL_ID = "tfs-requirment";
		/** 左侧菜单行文案（宿主 `resolveSlotLabel` 也接受 thunk，此处给字面量即可）。 */
		const PANEL_LABEL = "TFS 看板";
		/**
		* 左侧菜单行图标。
		*
		* 宿主按 `renderSlot('sidebar.panellist', { size, active }, { only: id })` 渲染，
		* 故 props 形状是 `SidebarPanelIconOwnerProps { size: number; active: boolean }`
		* （`packages/client/ui-sidebar/src/client/contract/slots.ts`）。
		* 颜色用 `currentColor`：选中态由宿主行样式（`panelActive`）改前景色，图标自动跟随。
		*/
		function TfsPanelIcon(props) {
			const size = props.size ?? 18;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				[PANEL_ROW_HOOK]: "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2",
						y: "2.5",
						width: "12",
						height: "11",
						rx: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2 6.5h12" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 6.5v7M10.5 6.5v7" })
				]
			});
		}
		/**
		* 「宿主不可达」原因的前缀。
		*
		* 兜底面板数据与"宿主正常但确实没有数据"在字段上无法区分（都是空清单），
		* 而桥方法一律降级返回、从不 reject，所以面板顶部的错误横幅此前永远不会被触发 ——
		* 插件没装进 profile 时，用户看到的是"暂无角色，点击右上「＋ 新建角色」"，
		* 完全没有"宿主不可达"这个事实。用带前缀的告警把两者区分开，横幅据此显示。
		*/
		const HOST_UNREACHABLE = "宿主不可达：";
		/**
		* 网络/业务失败的兜底面板数据。
		*
		* **刻意全部给空清单**（问题 4/5/6/7）：兜底数据只在"连不上宿主"时出现，
		* 此时给任何假模型/假 MCP 名都会让用户以为那是 dsh 真实可选的，选了必然失败。
		* 空清单 + 一条带 {@link HOST_UNREACHABLE} 前缀的告警，才是诚实的降级。
		*
		* @param reason - 不可达的判定依据（HTTP 状态或网络异常），会并入告警。
		*/
		function fallbackPanelData(reason) {
			return {
				targetWorkItem: "—",
				collection: "WN_HIS",
				roles: [],
				models: [],
				mcpServers: [],
				skills: [],
				modelOptions: [],
				workspaces: [],
				presets: [],
				providers: [],
				skillOptions: [],
				tagSuggestions: [
					"dsh",
					"tfs-requirment",
					"auto"
				],
				collections: ["WN_HIS"],
				pollIntervalMinutes: 5,
				catalogWarnings: [`${HOST_UNREACHABLE}${reason}`]
			};
		}
		/**
		* 统一 POST JSON 并解析响应。
		*
		* 失败状态必须翻成 `{ ok: false, reason }`：宿主统一用 `sendError` 回 `{ error: message }`
		* （`host/http-util.ts`），而此前这里不看 `res.ok`，直接把这个体当成正常结果返回 ——
		* 于是 400/405/413/500 全部变成 `ok === undefined`，界面只能显示兜底的"操作失败"，
		* 宿主给出的可读原因（"expectedRevision 必须是非负整数"、"角色字段 defaultMcp 必须是字符串数组"…）
		* 永远到不了用户眼前。
		*/
		async function postJson(path, body) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				cache: "no-store",
				body: JSON.stringify(body)
			});
			const data = await res.json().catch(() => null);
			if (res.ok) return data;
			return {
				ok: false,
				reason: data?.error ?? `请求失败（HTTP ${res.status}）`
			};
		}
		/**
		* 真实宿主桥：经 HTTP 路由调宿主半（Principle IV：写操作唯一出口在宿主半）。
		*/
		var HttpHostBridge = class {
			last = null;
			async getPanelData() {
				try {
					const res = await fetch(TFS_ROUTES.panelData, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return fallbackPanelData(`面板数据路由返回 HTTP ${res.status}`);
					const data = await res.json();
					this.last = data;
					return data;
				} catch (e) {
					return fallbackPanelData(e instanceof Error ? e.message : String(e));
				}
			}
			/**
			* 强制重采能力目录后再取面板数据（问题 4/5/6/7/9/11 的"事后配置"场景）。
			*
			* 用户完全可能先打开插件、后配模型 / 装技能 / 加 MCP server。`getPanelData` 只读宿主
			* 内存快照，此时会永远显示首次采集的结果。本方法走 `catalog-refresh` 路由触发重采。
			* 失败时回退到普通 `getPanelData`（不把"刷新失败"变成"面板空白"）。
			*/
			async refreshPanelData() {
				try {
					const res = await fetch(TFS_ROUTES.catalogRefresh, {
						method: "POST",
						cache: "no-store",
						headers: { "content-type": "application/json" },
						body: "{}"
					});
					if (!res.ok) return this.getPanelData();
					const data = await res.json();
					this.last = data;
					return data;
				} catch {
					return this.getPanelData();
				}
			}
			/**
			* 确认回写（过四道门禁后直连 TFS REST 写入）。
			*
			* ## 目标必须由调用方显式传入（2026-09-21 实机事故修复）
			*
			* 宿主下发的 `panel-data.targetWorkItem` 是**占位符** `'—'`（`host/api.ts#getPanelData` 硬编码）：
			* "当前目标"是**客户端会话内**的状态（用户在需求池/任务中心点了谁），宿主根本无从知晓。
			* 旧实现只取 `this.last?.targetWorkItem` ⇒ 用户明明"选为目标"了，确认回写仍发出 `'—'`，
			* 得到 *targetWorkItem 缺少有效工作项 id：—*。
			* 故目标一律以调用方（正在渲染的那份面板数据）为准，`this.last` 只作最后兜底。
			*
			* @param ops - 回写草稿。
			* @param target - 目标需求（`id@collection` + 集合）。
			* @returns 回写结果。
			*/
			async confirmWrite(ops, target) {
				try {
					const body = await postJson(TFS_ROUTES.confirmWrite, {
						ops,
						targetWorkItem: target?.targetWorkItem ?? this.last?.targetWorkItem ?? "—",
						collection: target?.collection ?? this.last?.collection ?? ""
					});
					return {
						ok: body.ok,
						reason: body.reason
					};
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主回写服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			/**
			* 发起执行（并发派发到角色智能体）。
			*
			* 目标口径与 {@link confirmWrite} 完全一致：以调用方传入的 target 为准，
			* `this.last` 只作兜底（否则 exec 面板发出的 taskId 会退化成 `—#role-coder`）。
			*
			* @param req - 派发草稿。
			* @param taskId - 看板任务 id（有则宿主据此回绑状态/轨迹）。
			* @param target - 目标需求。
			* @returns 派发结果。
			*/
			async dispatch(req, taskId, target) {
				try {
					const body = await postJson(TFS_ROUTES.dispatch, {
						draft: req,
						targetWorkItem: target?.targetWorkItem ?? this.last?.targetWorkItem ?? "—",
						collection: target?.collection ?? this.last?.collection ?? "",
						...taskId ? { taskId } : {}
					});
					return {
						ok: body.ok,
						...body.reason ? { reason: body.reason } : {},
						...body.taskId ? { taskId: body.taskId } : {},
						...body.createdTask ? { createdTask: true } : {},
						...body.workspace ? { workspace: body.workspace } : {},
						...body.scheduled ? { scheduled: true } : {},
						...body.scheduledAt ? { scheduledAt: body.scheduledAt } : {}
					};
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主分发服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			async listRequirements(filter) {
				try {
					return await postJson(TFS_ROUTES.requirements, filter);
				} catch {
					return {
						ok: false,
						items: [],
						reason: "无法连接到宿主需求服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			/** 需求筛选可选项（问题 3：项目/类型/状态/指派人，宿主从真实 TFS 采集；命中宿主缓存则不重采）。 */
			async getQueryOptions() {
				try {
					const res = await fetch(TFS_ROUTES.queryOptions, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) throw new Error(`返回 ${res.status}`);
					return await res.json();
				} catch {
					return {
						projects: [],
						types: [],
						states: [],
						assignees: [],
						reason: "无法连接到宿主筛选选项服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			/**
			* 强制重采可选项（FR-003）。
			*
			* 宿主对可选项做了进程内缓存（避免每次打开页签都跑数百次 TFS 元数据请求），
			* 代价是 TFS 上新建项目/类型后会滞后。本方法走 `POST /query-options-refresh` 绕过缓存。
			* 路由不存在（旧宿主）时退回普通读取 —— 拿不到新鲜数据，但不比现状更差。
			*/
			async refreshQueryOptions() {
				try {
					const body = await postJson(TFS_ROUTES.queryOptionsCollect, {});
					if (body.ok && body.data) return body.data;
					if (body.reason) return {
						projects: [],
						types: [],
						states: [],
						assignees: [],
						reason: body.reason
					};
					return this.getQueryOptions();
				} catch {
					return this.getQueryOptions();
				}
			}
			/** 问题 1：只读本地落盘的可选项，不触发 TFS 采集；无缓存 data=null。 */
			async loadQueryOptions(collection) {
				try {
					const qs = collection ? `?collection=${encodeURIComponent(collection)}` : "";
					const res = await fetch(`${TFS_ROUTES.queryOptionsLoad}${qs}`, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {
						ok: false,
						data: null
					};
					return await res.json();
				} catch {
					return {
						ok: false,
						data: null
					};
				}
			}
			/** 问题 1：强制重采可选项并落盘覆盖（「采集可选项」按钮）。 */
			async collectQueryOptions(collection) {
				try {
					return await postJson(TFS_ROUTES.queryOptionsCollect, collection ? { collection } : {});
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主筛选选项服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			/** 问题 2/4/6：读 UI 状态（筛选记忆/每页条数）。 */
			async loadUiState(collection) {
				try {
					const qs = collection ? `?collection=${encodeURIComponent(collection)}` : "";
					const res = await fetch(`${TFS_ROUTES.uiState}${qs}`, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {};
					return await res.json();
				} catch {
					return {};
				}
			}
			/** 问题 2/4/6：合并保存 UI 状态。 */
			async saveUiState(patch, collection) {
				try {
					return await postJson(TFS_ROUTES.uiState, collection ? {
						...patch,
						collection
					} : patch);
				} catch {
					return {
						ok: false,
						reason: "UI 状态保存失败（本地文件不可写）"
					};
				}
			}
			async listRoles() {
				try {
					return (await (await fetch(TFS_ROUTES.roles, {
						method: "GET",
						cache: "no-store"
					})).json()).roles ?? [];
				} catch {
					return [];
				}
			}
			async saveRole(role) {
				try {
					return await postJson(TFS_ROUTES.roleSave, role);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主角色服务"
					};
				}
			}
			async deleteRole(id, force) {
				try {
					return await postJson(TFS_ROUTES.roleDelete, {
						id,
						force
					});
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主角色服务"
					};
				}
			}
			async listSkillGroups() {
				try {
					return (await (await fetch(TFS_ROUTES.skillGroups, {
						method: "GET",
						cache: "no-store"
					})).json()).groups ?? [];
				} catch {
					return [];
				}
			}
			async saveSkillGroup(group) {
				try {
					return await postJson(TFS_ROUTES.skillGroupSave, group);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主技能分组服务"
					};
				}
			}
			async deleteSkillGroup(id) {
				try {
					return await postJson(TFS_ROUTES.skillGroupDelete, { id });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主技能分组服务"
					};
				}
			}
			async getBoard() {
				try {
					const res = await fetch(TFS_ROUTES.board, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return boardUnavailable(`看板路由返回 ${res.status}`);
					return await res.json();
				} catch {
					return boardUnavailable("无法连接到宿主看板服务（请确认插件已在 profile 启用并重启界面）");
				}
			}
			async claimRequirement(input) {
				try {
					return await postJson(TFS_ROUTES.claim, input);
				} catch {
					return {
						ok: false,
						added: false,
						reason: "无法连接到宿主领取服务"
					};
				}
			}
			async decomposeRequirement(requirementId) {
				try {
					return await postJson(TFS_ROUTES.decompose, { requirementId });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主拆解服务"
					};
				}
			}
			/** 开始编排（2026-11-03 问题 4/5）：立刻链式 / 定时（精确到分）。 */
			async orchestrationStart(input) {
				try {
					return await postJson(TFS_ROUTES.orchestrationStart, input);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主编排服务"
					};
				}
			}
			/** 定时执行条目清单（问题 4/5；2026-11-03 问题 3 类型化）。 */
			async listSchedules() {
				try {
					const res = await fetch(TFS_ROUTES.schedules, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {
						ok: false,
						reason: `调度清单接口返回 ${res.status}`
					};
					return await res.json();
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主调度服务"
					};
				}
			}
			/** 取消一条定时执行（问题 4/5）。 */
			async cancelSchedule(id) {
				try {
					return await postJson(TFS_ROUTES.scheduleCancel, { id });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主调度服务"
					};
				}
			}
			/** 修改定时执行的到点时刻（2026-11-03 问题 3）。 */
			async updateSchedule(id, dueAt) {
				try {
					return await postJson(TFS_ROUTES.scheduleUpdate, {
						id,
						dueAt
					});
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主调度服务"
					};
				}
			}
			/** 问题 7：还原已领取需求回需求池。 */
			async restoreRequirement(requirementKey) {
				try {
					return await postJson(TFS_ROUTES.requirementRestore, { requirementKey });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主看板服务"
					};
				}
			}
			/** 问题 11：实时重取需求四段描述并回写看板。 */
			async enrichRequirement(requirementKey) {
				try {
					return await postJson(TFS_ROUTES.requirementEnrich, { requirementKey });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主看板服务"
					};
				}
			}
			/** 问题 8：删除已取消任务（批量，整批门禁）。 */
			async deleteTasks(taskIds) {
				try {
					return await postJson(TFS_ROUTES.taskDelete, { taskIds });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主看板服务"
					};
				}
			}
			/** 问题 3：编辑已领取需求的本地字段（提示词 / 工作目录）。 */
			async updateRequirement(input) {
				try {
					return await postJson(TFS_ROUTES.requirementUpdate, input);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主看板服务（需求编辑）"
					};
				}
			}
			/** 问题 4：编辑任务字段（提示词 / 模型 / 技能 / MCP / 工作目录）。 */
			async updateTask(input) {
				try {
					return await postJson(TFS_ROUTES.taskUpdate, input);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主看板服务（任务编辑）"
					};
				}
			}
			/**
			* 问题 5：设置需求级执行状态（确认完成 / 取消完成）。
			*
			* 「已完成」页的「取消完成」与「还原到需求池」的前置门禁都走这里 —— 完成与撤销是两个
			* 显式动作，不提供"一步跨过"的捷径。
			*/
			async setRequirementExecState(input) {
				try {
					return await postJson(TFS_ROUTES.requirementExecState, input);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主看板服务（需求执行状态）"
					};
				}
			}
			async assignTask(taskId, roleName) {
				try {
					return await postJson(TFS_ROUTES.taskAssign, {
						taskId,
						roleName
					});
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主任务服务"
					};
				}
			}
			async setTaskState(taskId, action, expectedRevision) {
				try {
					return await postJson(TFS_ROUTES.taskState, {
						taskId,
						action,
						expectedRevision
					});
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主任务服务"
					};
				}
			}
			/** spec 006 US2：读取某次任务执行的过程轨迹（技能/MCP/工具调用时间线）。 */
			async getTaskTrace(taskId, attemptIndex) {
				try {
					const qs = new URLSearchParams({ taskId });
					if (attemptIndex !== void 0) qs.set("attempt", String(attemptIndex));
					const res = await fetch(`${TFS_ROUTES.taskTrace}?${qs.toString()}`, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {
						ok: false,
						taskId,
						attempt: attemptIndex ?? -1,
						available: false,
						entries: [],
						reason: `轨迹路由返回 ${res.status}`
					};
					return await res.json();
				} catch {
					return {
						ok: false,
						taskId,
						attempt: attemptIndex ?? -1,
						available: false,
						entries: [],
						reason: "无法连接到宿主任务轨迹服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			/** spec 006 US3：对任务追问 / 补充指令（同角色同配置起新一轮执行）。 */
			async followUpTask(input) {
				try {
					return await postJson(TFS_ROUTES.taskFollowUp, input);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主任务服务（追问失败）"
					};
				}
			}
			/**
			* 问题 4：需求完成自动回写（评审/自测字段、结论评论、产物附件、关联任务收口）。
			* POST 触发 / 强制重跑；逐项结果在 `report` 中。成功后让共享看板 store 立即失效刷新。
			*/
			async writeBackRequirement(input) {
				try {
					const res = await postJson(TFS_ROUTES.requirementWriteBack, input);
					if (res.ok) boardStore.invalidate();
					return res;
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主回写服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			/**
			* spec 010：确保需求有编排主 agent 会话（幂等；失败给可读降级原因）。
			* 成功后让共享看板 store 失效，任务中心下一次刷新即可看到会话 id 并接上对话框。
			*/
			async orchestratorEnsure(requirementKey, force) {
				try {
					const res = await postJson(TFS_ROUTES.orchestratorEnsure, {
						requirementKey,
						...force === true ? { force: true } : {}
					});
					if (res.ok) boardStore.invalidate();
					return res;
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主编排服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
			async healthCheck() {
				try {
					const res = await fetch(TFS_ROUTES.health, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {
						ok: false,
						kind: "unknown",
						reason: `自检路由返回 ${res.status}`
					};
					return await res.json();
				} catch {
					return {
						ok: false,
						kind: "unknown",
						reason: "无法连接到宿主自检服务"
					};
				}
			}
			async getAudit() {
				try {
					const res = await fetch(TFS_ROUTES.audit, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {
						ok: false,
						total: 0,
						expired: 0,
						retentionDays: 0,
						archiveFiles: [],
						reason: `审计路由返回 ${res.status}`
					};
					return await res.json();
				} catch {
					return {
						ok: false,
						total: 0,
						expired: 0,
						retentionDays: 0,
						archiveFiles: [],
						reason: "无法连接到宿主审计服务"
					};
				}
			}
			async archiveAudit() {
				try {
					return await postJson(TFS_ROUTES.auditArchive, {});
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主审计服务"
					};
				}
			}
			async setCollection(collection) {
				try {
					return await postJson(TFS_ROUTES.collection, { collection });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主集合服务"
					};
				}
			}
			async listProfiles() {
				try {
					const res = await fetch(TFS_ROUTES.profiles, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) return {
						ok: false,
						profiles: [],
						reason: `档案路由返回 ${res.status}`
					};
					return await res.json();
				} catch {
					return {
						ok: false,
						profiles: [],
						reason: "无法连接到宿主档案服务"
					};
				}
			}
			async saveProfile(input) {
				try {
					return await postJson(TFS_ROUTES.profileSave, input);
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主档案服务"
					};
				}
			}
			async deleteProfile(id) {
				try {
					return await postJson(TFS_ROUTES.profileDelete, { id });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主档案服务"
					};
				}
			}
			async activateProfile(id) {
				try {
					return await postJson(TFS_ROUTES.profileActivate, { id });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主档案服务"
					};
				}
			}
			async getMcpSetup(_profileId) {
				try {
					const res = await fetch(TFS_ROUTES.mcpInstance, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) throw new Error(`返回 ${res.status}`);
					return await res.json();
				} catch {
					const serverName = "";
					return {
						ok: false,
						instance: {
							serverName,
							serverNameValid: false,
							toolPrefix: "",
							runtimeAddSupported: false,
							runtimeAddReason: "无法连接到宿主的连接诊断服务（插件未启用或无 web 服务）",
							serverNameConstraint: "不适用（REST 直连）",
							duplicateRisk: "未知（诊断不可用）",
							credentialPath: "未知（诊断不可用）"
						},
						template: {
							ok: false,
							serverName,
							serverNameValid: false,
							envFilePath: "",
							posixLines: [],
							powershellLines: [],
							note: "诊断不可用，无法生成凭据导出模板"
						}
					};
				}
			}
			async writeMcpEnvFile(profileId) {
				try {
					return await postJson(TFS_ROUTES.mcpEnvFile, { ...profileId ? { profileId } : {} });
				} catch {
					return {
						ok: false,
						reason: "无法连接到宿主连接诊断服务"
					};
				}
			}
			/** 能力目录：`tfs_req_*` 工具 ⇄ REST 操作键，含"端点是否已接入"的缺口标注。 */
			async getTfsToolCatalog() {
				try {
					const res = await fetch(TFS_ROUTES.tfsTools, {
						method: "GET",
						cache: "no-store"
					});
					if (!res.ok) throw new Error(`返回 ${res.status}`);
					return await res.json();
				} catch {
					return {
						ok: false,
						rawCount: 0,
						wrappedCount: 0,
						tools: [],
						missingCount: 0,
						reason: "无法连接到宿主工具目录服务（请确认插件已在 profile 启用并重启界面）"
					};
				}
			}
		};
		/** 看板不可用时的降级快照（区别于"空看板"：ok=false 让 UI 显式提示而不是静默显示 0）。 */
		function boardUnavailable(reason) {
			return {
				ok: false,
				reason,
				version: 0,
				updatedAt: "",
				requirements: [],
				tasks: [],
				counts: {
					pending: 0,
					inProgress: 0,
					completed: 0,
					running: 0,
					queued: 0
				}
			};
		}
		const bridge = new HttpHostBridge();
		/**
		* 模块级共享看板 store（问题 1/6/7）。
		*
		* 中央 Workbench 与右栏 SidePanel 即便同时挂载，也共用这一份快照、一条自适应轮询链：
		* 单飞合并并发 getBoard、运行中 3s/待确认 5s/全空闲停拍、动作后立即失效刷新。
		* DAG 推进由宿主收口钩子负责（问题 6），前端轮询只用于展示，故全空闲可安全停拍。
		*/
		const boardStore = new BoardStore(() => bridge.getBoard());
		/**
		* 旧 / 精简宿主（无 main 槽）上，连接 footer.action 入口与 shell.overlay 面板的
		* 开关控制器单例（见 shared/panel-open-control.ts）。
		*/
		const panelOpen = new PanelOpenControl();
		/**
		* TFS 工作台：单浮层容器，内含 需求池 / 任务中心 / 执行配置 / 角色管理 / 连接诊断 五个标签页。
		*
		* 端到端链路（真实接线，非占位）：
		*   需求池「按 ID 领取」→ BoardService.claimRequirement（入本地池 + 打 dsh 标签）
		*   → 任务中心「拆解为任务」→ decomposeRequirement（五段式 DAG：分析→架构师拆解→开发→代码审核→测试）
		*   → 「启动/完成/重试/取消」→ setTaskState（四态 + 乐观锁）
		*   → 需求池/任务中心「选为目标」→ 执行配置的目标变为 `id@collection`
		*   → 执行配置「确认回写」→ confirmWrite（过 WriteGuard 四道门禁，直连 REST 写 TFS）
		*/
		function Workbench(props) {
			const [tab, setTabState] = (0, react.useState)("pool");
			const [data, setData] = (0, react.useState)(null);
			const board = useBoardStore(boardStore);
			const [health, setHealth] = (0, react.useState)(null);
			const [target, setTarget] = (0, react.useState)(null);
			/**
			* 「选为目标」填充序号（spec 008 US4）：每次显式点击 chooseTarget 自增。
			*
			* 纯客户端会话态：随 execData 注入给执行面板，触发其把标题/描述/执行 Prompt 重新填入表单。
			* 不能用"目标键"去重——同一需求第二次选为目标（如发起执行清空表单后想恢复正文）
			* 目标键不变，旧实现因此静默跳过填充。轮询刷新不产生新序号，不会顶掉手工编辑。
			*/
			const [targetFillNonce, setTargetFillNonce] = (0, react.useState)(0);
			const [error, setError] = (0, react.useState)(null);
			const [audit, setAudit] = (0, react.useState)(null);
			const [profiles, setProfiles] = (0, react.useState)(null);
			const [mcp, setMcp] = (0, react.useState)(null);
			const [toolCatalog, setToolCatalog] = (0, react.useState)(null);
			/**
			* 问题 6：批量派发已改为"只启动首批 + 宿主自动链式"，不再有前端轮询进度，
			* 故进度文案恒为 null（结果摘要在批量动作的返回 reason 中即时展示）。保留 props 形状，
			* 避免 TaskCenter 签名改动。
			*/
			const [batchProgress] = (0, react.useState)(null);
			/**
			* 问题 3：Tab 保活——每个 Tab 首次访问后**挂载一次、之后只隐藏不卸载**
			* （容器 `display:none`），切回时保留筛选、分页、已拉列表与表单状态，不重新请求数据。
			*/
			const [visited, setVisited] = (0, react.useState)({
				pool: true,
				tasks: false,
				exec: false,
				roles: false,
				groups: false,
				diag: false
			});
			const setTab = (0, react.useCallback)((next) => {
				setTabState(next);
				setVisited((prev) => prev[next] ? prev : {
					...prev,
					[next]: true
				});
			}, []);
			/**
			* 面板数据的**唯一落地口**（2026-10-06 修复）。
			*
			* 桥方法一律降级返回、从不 reject，所以"宿主不可达"只能靠兜底数据带出的告警识别。
			* 这条信息改由面板顶部横幅独占展示：从 catalogWarnings 里摘掉，避免与页签内的
			* 能力目录告警区重复显示同一条。
			*
			* ⚠️ 必须**所有**取到面板数据的路径都过这里（此前只有首屏 `reload()` 走，
			* 手动重采与后台续采都直接 `setData`）：于是运行期宿主失联时（面板打开时还是好的），
			* 「宿主不可达」只会静静躺在 `data.catalogWarnings` 里 —— 而那个字段只在
			* 「执行配置 / 角色管理」页渲染，停留在需求池 / 任务中心的用户**完全看不到任何提示**。
			*/
			const applyPanelData = (0, react.useCallback)((d) => {
				const unreachable = (d.catalogWarnings ?? []).find((w) => w.startsWith(HOST_UNREACHABLE));
				setData(unreachable ? {
					...d,
					catalogWarnings: (d.catalogWarnings ?? []).filter((w) => w !== unreachable)
				} : d);
				setError(unreachable ?? null);
			}, []);
			const reload = (0, react.useCallback)(() => {
				bridge.getPanelData().then(applyPanelData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
			}, [applyPanelData]);
			/**
			* 重新拉取看板快照（问题 5/10：领取/拆解/还原/删除/状态动作后 await 本函数，
			* 保证任务中心与需求池行内标记实时同步）。
			*
			* 走共享 store 的**单飞** refresh：与自适应轮询、其他动作共享同一个在途 getBoard，
			* 不会因为"轮询正好在跑 + 动作后又拉一次"而发出重复请求（问题 1）。
			*/
			const reloadBoard = (0, react.useCallback)(async () => {
				try {
					await boardStore.refresh();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, []);
			/**
			* 强制重采 DSH 能力目录（问题 1/2）。
			*
			* 这是"用户先打开插件、后装技能 / 加 MCP / 加模型"场景的唯一自救入口。
			* 走 `POST /catalog-refresh`（宿主 `api.refreshPanelData`）→ 重采后再取面板数据。
			*/
			const refreshCatalog = (0, react.useCallback)(async () => {
				const next = await bridge.refreshPanelData();
				applyPanelData(next);
			}, []);
			/**
			* 问题 1/2：进入「执行配置」「角色管理」时自动重采能力目录。
			*
			* 之前只有右侧栏的 TFS 执行页会重采（`SidePanel.tsx`），中央工作台**从不**重采 ——
			* 于是这两个页签的下拉永远是"首次采集那一刻"的结果，用户新装的技能/MCP 看不到。
			* 这里挂在 **Tab 激活**上（而不是挂载时一次）：与 003 的 Tab 保活机制一致，
			* 既覆盖"每次要看下拉时都拿最新的"，又不会周期性打 provider 接口。
			*
			* 5 秒节流：`catalog.refresh()` 内部已做 inflight 去重，但连续点两个页签仍会真实重采两轮
			* （第一轮已结束），而 `listModels()` 会逐 provider 发请求 —— 用户手速不该变成负载。
			*/
			const lastCatalogRefreshRef = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				if (tab !== "exec" && tab !== "roles") return;
				if (Date.now() - lastCatalogRefreshRef.current < 5e3) return;
				lastCatalogRefreshRef.current = Date.now();
				bridge.refreshPanelData().then(applyPanelData).catch(() => {});
			}, [tab, applyPanelData]);
			/**
			* 问题 1/2：已访问过「执行配置 / 角色管理」后，按宿主下发的轮询间隔**后台续采**能力目录。
			*
			* 为什么还需要它（不是画蛇添足）：用户级技能挂在 agent preset 的**standing mount** 上，
			* 而那个挂载是"某个会话按该预设启动"时才建立的（`dsh-agent-presets` 的 `ensureStanding`）。
			* 用户完全可能是"先开面板、后开会话"，此时一次性重采仍然只拿到全局层；
			* 按需间隔再采一次就能自动补齐，无需用户记得点按钮。间隔取 `pollIntervalMinutes`（默认 5 分钟），
			* 与需求池的轮询同一节奏，一次采集的成本是 `listModels() × provider + list(skills)` 的量级。
			*/
			const catalogPolling = visited.exec || visited.roles;
			const catalogIntervalMinutes = data?.pollIntervalMinutes ?? 5;
			(0, react.useEffect)(() => {
				if (!catalogPolling) return;
				const id = setInterval(() => {
					bridge.refreshPanelData().then(applyPanelData).catch(() => {});
				}, Math.max(1, catalogIntervalMinutes) * 60 * 1e3);
				return () => clearInterval(id);
			}, [
				catalogPolling,
				catalogIntervalMinutes,
				applyPanelData
			]);
			/**
			* 选为目标（问题 11）：先经宿主实时重取工作项四段正文（详细信息/需求分析/数据结构/需求配置）
			* 并回写看板，再刷新快照、设置目标、跳到执行配置页。重取失败时降级用列表项自带字段，不阻断。
			*/
			const chooseTarget = (0, react.useCallback)(async (item) => {
				const key = `${item.id}@${item.collection}`;
				let enriched = item;
				try {
					const r = await bridge.enrichRequirement(key);
					if (r.ok && r.requirement) enriched = r.requirement;
				} catch {}
				await reloadBoard();
				setTarget(enriched);
				setTargetFillNonce((n) => n + 1);
				setTab("exec");
			}, [reloadBoard, setTab]);
			/**
			* 派发一个看板任务（单行「派发执行」与批量派发共用）。
			*
			* prompt 交给宿主组装（`api.dispatch` 会拼「工作目录 → 需求提示词 → 任务提示词 → 标题/描述」），
			* 这里只传任务自己的提示词：客户端拼 prompt 会把"需求提示词实时生效"这条语义丢掉。
			*/
			const dispatchBoardTask = (0, react.useCallback)(async (t) => {
				const role = data?.roles.find((r) => r.name === t.roleAgent);
				return bridge.dispatch({
					roleName: t.roleAgent,
					prompt: t.prompt ?? "",
					frozenConfig: t.frozenConfig,
					permission: role?.defaultPermission ?? "read-only",
					...t.workspace ? { workspace: t.workspace } : {}
				}, t.taskId, targetRefFromKey(t.requirementId || t.taskId, data?.collection ?? ""));
			}, [data]);
			/**
			* 问题 5/6/1：勾选批量派发 —— 只负责把**当前就绪的首批**任务派出去，后续波次交给宿主自动链式。
			*
			* ## 为什么不再在前端轮询驱动 DAG
			*
			* 旧实现用 `setInterval(1.5s) × 最多 400 轮` 全量 getBoard 来"等上游完成 → 派下游"：
			*   - 页面关闭 / 切走即停，任务链断在半路；
			*   - 每拍一次全量看板请求，是无意义的请求风暴（问题 1）；
			*   - 与宿主收口逻辑各跑一套，容易重复派发。
			*
			* 现在 DAG 推进下沉到宿主：每条任务收口（成功）时，收口钩子调用 `Board.autoStartRunnable`
			* 自动启动所有"依赖已完成、并发槽有空"的就绪任务（问题 6），与页面是否打开无关。
			* 因此前端批量派发只需：取一次最新快照 → 用纯逻辑 `planBatchStep` 算出"现在能派谁"
			* → 派发就绪首批（≤ 并发上限）→ 动作后失效刷新；其余任务在 skipped 里标注"将自动执行"。
			*
			* @param ids - 勾选的任务 id。
			* @returns 首批分波明细与自动排队 / 未能派发的可读原因。
			*/
			const dispatchBatch = (0, react.useCallback)(async (ids) => {
				const waves = [];
				const skipped = [];
				if (ids.length === 0) return {
					ok: false,
					dispatched: 0,
					skipped,
					waves,
					reason: "未选择任何任务"
				};
				const limit = Math.max(1, data?.dispatchConcurrency ?? 3);
				let snap;
				try {
					snap = await boardStore.refresh();
				} catch (e) {
					return {
						ok: false,
						dispatched: 0,
						skipped: ids.map((taskId) => ({
							taskId,
							reason: "读取看板快照失败"
						})),
						waves,
						reason: `读取看板快照失败：${e instanceof Error ? e.message : String(e)}`
					};
				}
				if (!snap.ok) return {
					ok: false,
					dispatched: 0,
					skipped: ids.map((taskId) => ({
						taskId,
						reason: "看板不可用"
					})),
					waves,
					reason: `看板不可用：${snap.reason ?? "未知原因"}`
				};
				const step = planBatchStep(snap.tasks, ids);
				const doneIds = step.done;
				for (const s of step.stuck) skipped.push(s);
				const wave = step.ready.slice(0, limit);
				const failures = [];
				const okIds = [];
				for (const id of wave) {
					const t = snap.tasks.find((x) => x.taskId === id);
					if (!t) {
						failures.push({
							taskId: id,
							reason: "任务不存在（可能已被删除）"
						});
						continue;
					}
					const r = await dispatchBoardTask(t);
					if (r.ok) okIds.push(id);
					else failures.push({
						taskId: id,
						reason: r.reason ?? "派发失败"
					});
				}
				if (okIds.length > 0 || failures.length > 0) waves.push({
					taskIds: okIds,
					failures
				});
				const accounted = /* @__PURE__ */ new Set([
					...doneIds,
					...skipped.map((s) => s.taskId),
					...okIds,
					...failures.map((f) => f.taskId)
				]);
				for (const id of ids) {
					if (accounted.has(id)) continue;
					skipped.push({
						taskId: id,
						reason: "已排队：上游任务完成后将自动执行（无需逐个点击）"
					});
				}
				boardStore.invalidate();
				const dispatched = doneIds.length;
				if (failures.length === 0) {
					const queued = skipped.filter((s) => s.reason.startsWith("已排队")).length;
					return {
						ok: true,
						dispatched,
						skipped,
						waves,
						reason: `已启动首批 ${okIds.length} 个任务` + (queued > 0 ? `，其余 ${queued} 个将在上游完成后自动执行` : "") + (dispatched > 0 ? `；已完成 ${dispatched} 个` : "")
					};
				}
				return {
					ok: false,
					dispatched,
					skipped,
					waves,
					reason: `首批有 ${failures.length} 个任务派发失败（可单独点「重试」）；其余任务将在依赖满足后自动执行`
				};
			}, [data, dispatchBoardTask]);
			(0, react.useEffect)(() => {
				evictTakeoverPanels();
				reload();
			}, [reload]);
			const diagVisited = visited.diag;
			(0, react.useEffect)(() => {
				if (!diagVisited) return;
				bridge.getAudit().then(setAudit);
				bridge.listProfiles().then(setProfiles);
				bridge.getMcpSetup().then(setMcp);
				bridge.getTfsToolCatalog().then(setToolCatalog);
			}, [diagVisited]);
			(0, react.useEffect)(() => {
				if (tab !== "tasks") return;
				boardStore.invalidate();
			}, [tab]);
			(0, react.useEffect)(() => {
				const onKey = (e) => {
					if (e.key !== "Escape") return;
					const el = e.target;
					if (el) {
						const tag = el.tagName;
						if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
					}
					props.onClose?.();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [props.onClose]);
			const actions = () => ({
				confirmWrite: (ops, target) => bridge.confirmWrite(ops, target),
				dispatch: async (req, taskId, target) => {
					const res = await bridge.dispatch(req, taskId, target);
					if (res.ok) await reloadBoard();
					return res;
				},
				refreshCatalog,
				onDispatched: () => setTab("tasks")
			});
			const tabButton = (key, label) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-current": tab === key ? "page" : void 0,
				onClick: () => setTab(key),
				style: {
					padding: "8px 14px",
					border: "none",
					borderBottom: tab === key ? "2px solid #2563eb" : "2px solid transparent",
					background: "transparent",
					color: tab === key ? "#2563eb" : "#6b7280",
					cursor: "pointer",
					fontSize: 14,
					fontWeight: tab === key ? 600 : 400
				},
				children: label
			}, key);
			/**
			* 「连接与凭据」页（T029 自检 + T063 审计归档 + T031 档案 + 连接诊断）。
			*
			* 自检仍保持"点击才发起"（不在挂载时就打 TFS）；审计状态与连接诊断为**纯本地读取**
			* （读 audit.jsonl / 读档案），故随页签切换自动拉取即可，不会给 TFS 造成压力。
			*/
			const diagBody = () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectionPanel, {
				health,
				onHealthCheck: () => {
					setHealth(null);
					bridge.healthCheck().then(setHealth);
				},
				audit,
				onAuditRefresh: () => void bridge.getAudit().then(setAudit),
				onArchive: () => bridge.archiveAudit(),
				profiles,
				onProfilesRefresh: () => void bridge.listProfiles().then(setProfiles),
				onSaveProfile: (input) => bridge.saveProfile(input),
				onDeleteProfile: (id) => bridge.deleteProfile(id),
				onActivateProfile: async (id) => {
					const res = await bridge.activateProfile(id);
					if (res.ok) reload();
					return res;
				},
				mcp,
				onMcpRefresh: () => void bridge.getMcpSetup().then(setMcp),
				onWriteEnvFile: () => bridge.writeMcpEnvFile(),
				toolCatalog,
				onToolCatalogRefresh: () => void bridge.getTfsToolCatalog().then(setToolCatalog)
			});
			/**
			* 问题 3：五个 Tab 的面板节点。
			*
			* 关键：**首次访问即挂载，之后只通过外层容器 `display:none` 隐藏、永不卸载**——
			* React 保留组件 state（筛选/分页/已拉列表/表单），切 Tab 不触发任何重新加载。
			* 每个面板外层是 `flex:1 + overflow:auto` 的滚动容器（隐藏时 display:none）。
			*/
			const panelWrap = (key, node) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					flex: 1,
					minHeight: 0,
					overflow: "auto",
					display: tab === key ? "block" : "none"
				},
				"aria-hidden": tab !== key,
				children: node
			}, key);
			const poolPanel = panelWrap("pool", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RequirementPool, {
				collection: data?.collection ?? "",
				collections: data?.collections ?? [],
				onCollectionChange: async (c) => {
					const res = await bridge.setCollection(c);
					if (res.ok) {
						reload();
						reloadBoard();
					}
					return res;
				},
				listRequirements: (f) => bridge.listRequirements(f),
				getQueryOptions: () => bridge.getQueryOptions(),
				loadQueryOptions: (col) => bridge.loadQueryOptions(col),
				onCollectQueryOptions: (col) => bridge.collectQueryOptions(col),
				loadUiState: (col) => bridge.loadUiState(col),
				saveUiState: (patch, col) => bridge.saveUiState(patch, col),
				claimRequirement: (input) => bridge.claimRequirement(input),
				workspaces: data?.workspaces ?? [],
				tfsBaseUrl: data?.tfsBaseUrl,
				onClaimed: () => void reloadBoard(),
				claimedRequirements: board?.requirements ?? [],
				onSelect: (item) => void chooseTarget(item),
				pollIntervalMinutes: data?.pollIntervalMinutes
			}));
			/**
			* spec 010：任务中心改**左右分栏** —— 左任务表 + 右「主对话框」。
			*
			* 为什么对话框在这里而不是 TaskCenter 内部：`SessionProvider` / `renderSlot` 由**父槽位条目**
			* （就是本组件所属的 `main` 条目）持有，TaskCenter 拿不到；因此由这里包裹，
			* 组件之间的数据经模块级 store 传递（见 `OrchestratorChat.tsx`）。
			* 对话框自身在「已完成」子 Tab / 未选择需求时返回 null，不影响原有布局。
			*/
			const tasksPanel = visited.tasks ? panelWrap("tasks", data ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 12,
					alignItems: "stretch",
					minHeight: 0,
					height: "100%"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						flex: 1,
						minWidth: 0,
						minHeight: 0,
						overflowY: "auto"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCenter, {
						snapshot: board,
						active: tab === "tasks",
						roles: data.roles,
						collection: data.collection,
						onRefresh: reloadBoard,
						onDecompose: async (id) => {
							const r = await bridge.decomposeRequirement(id);
							if (r.ok && r.createdRoles && r.createdRoles.length > 0) reload();
							return r;
						},
						onOrchestrationStart: (key, input) => bridge.orchestrationStart({
							requirementKey: key,
							...input
						}),
						onRestore: (key) => bridge.restoreRequirement(key),
						onDeleteTasks: (ids) => bridge.deleteTasks(ids),
						onSetRequirementExecState: (input) => bridge.setRequirementExecState(input),
						onWriteBackRequirement: (key) => bridge.writeBackRequirement({
							requirementKey: key,
							force: true
						}),
						loadUiState: (col) => bridge.loadUiState(col),
						saveUiState: (patch, col) => bridge.saveUiState(patch, col),
						onAssign: (taskId, roleName) => bridge.assignTask(taskId, roleName),
						onTaskState: (taskId, action, rev) => bridge.setTaskState(taskId, action, rev),
						onGetTaskTrace: (taskId, attempt) => bridge.getTaskTrace(taskId, attempt),
						onFollowUpTask: async (input) => {
							const res = await bridge.followUpTask(input);
							await reloadBoard();
							return res;
						},
						onUpdateRequirement: (key, patch) => bridge.updateRequirement({
							requirementKey: key,
							...patch
						}),
						onUpdateTask: (input) => bridge.updateTask(input),
						onDispatchBatch: dispatchBatch,
						batchProgress,
						orchestration: data.orchestration,
						workspaces: data.workspaces,
						modelOptions: data.modelOptions,
						skillOptions: data.skillOptions,
						mcpServers: data.mcpServers,
						skillGroups: data.skillGroups,
						onListSchedules: () => bridge.listSchedules(),
						onCancelSchedule: (id) => bridge.cancelSchedule(id),
						onUpdateSchedule: (id, dueAt) => bridge.updateSchedule(id, dueAt),
						presets: data.presets,
						tfsBaseUrl: data.tfsBaseUrl,
						onDispatchTask: async (t) => {
							const res = await dispatchBoardTask(t);
							await reloadBoard();
							return res;
						},
						onSelectRequirement: (item) => void chooseTarget(item)
					})
				}), props.chatKit && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OrchestratorChatDock, {
					kit: props.chatKit,
					ctx: props.ctx,
					onEnsureOrchestrator: async (key, opts) => {
						if (opts?.workspace) {
							const saved = await bridge.updateRequirement({
								requirementKey: key,
								workspace: opts.workspace
							});
							if (!saved.ok) return {
								ok: false,
								reason: `保存工作目录失败：${saved.reason ?? "未知原因"}`
							};
							await reloadBoard();
						}
						return bridge.orchestratorEnsure(key, true);
					}
				})]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: 20,
					color: "#6b7280",
					fontSize: 13
				},
				children: "加载面板数据中…"
			})) : null;
			const execPanel = visited.exec ? panelWrap("exec", data ? (() => {
				const execData = target ? {
					...data,
					target,
					targetWorkItem: `${target.id}@${target.collection}`,
					collection: target.collection,
					targetFillNonce
				} : data;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionPanel, {
					data: execData,
					actions: actions()
				});
			})() : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: 20,
					color: "#6b7280",
					fontSize: 13
				},
				children: "加载面板数据中…"
			})) : null;
			const rolesPanel = visited.roles ? panelWrap("roles", data ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoleSettings, {
				roles: data.roles,
				providers: data.providers,
				modelOptions: data.modelOptions,
				skillOptions: data.skillOptions,
				mcpServers: data.mcpServers,
				presets: data.presets,
				onRefreshCatalog: refreshCatalog,
				catalogWarnings: data.catalogWarnings,
				catalogCollectedAt: data.catalogCollectedAt,
				onSave: async (role) => {
					const res = await bridge.saveRole(role);
					if (res.ok) {
						reload();
						reloadBoard();
					}
					return res;
				},
				onDelete: async (id, force) => {
					const res = await bridge.deleteRole(id, force);
					if (res.ok) {
						reload();
						reloadBoard();
					}
					return res;
				}
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: 20,
					color: "#6b7280",
					fontSize: 13
				},
				children: "加载面板数据中…"
			})) : null;
			const diagPanel = visited.diag ? panelWrap("diag", diagBody()) : null;
			/**
			* 技能/MCP 分组页（2026-11-03 用户诉求）：创建/编辑/删除"技能 + MCP 能力包"。
			* 保存/删除后 `reload()` 刷新面板数据，执行配置页与任务编辑弹框的分组下拉即时可见新值。
			*/
			const groupsPanel = visited.groups ? panelWrap("groups", data ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillGroupPanel, {
				groups: data.skillGroups ?? [],
				skillOptions: data.skillOptions ?? [],
				mcpServers: data.mcpServers ?? [],
				onSave: async (group) => {
					const res = await bridge.saveSkillGroup(group);
					if (res.ok) reload();
					return res;
				},
				onDelete: async (id) => {
					const res = await bridge.deleteSkillGroup(id);
					if (res.ok) reload();
					return res;
				}
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: 20,
					color: "#6b7280",
					fontSize: 13
				},
				children: "加载面板数据中…"
			})) : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"aria-label": "TFS 看板",
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minHeight: 0,
					background: "#fff",
					color: "#111827",
					fontFamily: "system-ui, sans-serif"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 4,
							padding: "8px 12px 0",
							borderBottom: "1px solid #e5e7eb"
						},
						children: [
							tabButton("pool", "需求池"),
							tabButton("tasks", board && board.ok ? `任务中心(${board.tasks.length})` : "任务中心"),
							tabButton("exec", "执行配置"),
							tabButton("roles", "角色管理"),
							tabButton("groups", "技能分组"),
							tabButton("diag", "连接与凭据"),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									marginLeft: "auto",
									fontSize: 12,
									color: "#9ca3af"
								},
								children: [
									"目标：",
									target ? `${target.id}@${target.collection}` : "未选择",
									data ? ` ｜ 集合：${data.collection}` : ""
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => props.onClose?.(),
								title: "关闭并返回会话（Esc）",
								"aria-label": "关闭并返回会话",
								style: {
									marginLeft: 8,
									width: 28,
									height: 28,
									borderRadius: 6,
									border: "1px solid #e5e7eb",
									background: "#fff",
									color: "#6b7280",
									fontSize: 16,
									lineHeight: "24px",
									cursor: "pointer"
								},
								children: "×"
							})
						]
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "6px 12px",
							fontSize: 12,
							color: "#b91c1c",
							background: "#fef2f2"
						},
						children: ["面板数据加载失败：", error]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: 1,
							minHeight: 0,
							display: "flex",
							flexDirection: "column"
						},
						children: [
							poolPanel,
							tasksPanel,
							execPanel,
							rolesPanel,
							groupsPanel,
							diagPanel
						]
					})
				]
			});
		}
		/**
		* 客户端半槽位接线：把「TFS 看板」注册进**左侧菜单** + **中央面板**。
		*
		* 两处注册缺一不可，且必须共用同一个 `PANEL_ID`：
		*   1. `sidebar.panellist`（kind: list，scope: root）—— 左侧菜单行。组件只负责画图标，
		*      行样式、文案、点击动作全由宿主 `SidebarRoot` 的 `PanelRow` 拥有；
		*   2. `main`（kind: keyed，scope: root）—— 中央面板，key = 同一 id。
		*
		* ## 关于"放在任务看板下方"——这是实测推出来的，不是猜的
		*
		* 侧边栏自上而下的真实结构（`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:218-265`）：
		* 品牌行 →「新建会话」按钮 → **`<nav>` 面板行列表** → 工作区浏览区 → 底部设置。
		* 「任务看板」那一行并**不是**槽位注册，而是第三方插件 DOM 注入：
		* `@linxin666/dsh-client-ui-task-board` 的 `sidebar-entry-core.ts` 明确写着
		* "dsh's sidebar shell exposes no slot an external plugin can register into"（该结论对
		* `sidebar.workspaces`/`sidebar.settings` 成立，但 `sidebar.panellist` 是 list 槽、可注册），
		* 它把自己插在「新建会话」之后。因此走槽位注册的面板行落在它**之后**，即下方。
		*
		* @param ctx - 客户端根上下文（运行期必含 slots 服务；此处经结构类型访问）。
		*/
		function registerExecutionPanel(ctx) {
			const slots = ctx.slots;
			ctx.effect(() => bindPanelRowEviction(), "tfs-requirment: takeover-panel eviction");
			/**
			* 关闭动作：返回会话面板。
			*
			* ## 为什么**延迟**到点击时才解析 `layout`（2026-09-19 修复"关闭按钮无效"）
			*
			* 旧实现把 `ctx.get('layout')` 放在 `registerExecutionPanel` 的**同步执行期**并闭包捕获。
			* 这是错的：`ctx.get(name, ...)` 在提供服务 `ui-layout` 的 fiber **尚未激活**时返回
			* `undefined`（cordis `vendor/cordis/lib/index.js` `_getImpl` 的 `state !== 2` 分支，
			* `:769`），而插件加载期宿主服务普遍还没激活 —— 实测坐实：
			* `root.get('llm', true) → undefined` / `root.get('llm', false) → 有值`。
			*
			* 后果：捕获到的 `layout` 恒为 `undefined` ⇒ `close()` 里 `layout?.selectPanel?.(null)`
			* 恒为静默 no-op ⇒ 用户点右上角关闭**没有任何反应**（正是用户报告的问题 2）。
			*
			* 修法：把服务解析推迟到**点击那一刻**（那时宿主早已完成激活）。
			*
			* ## 关闭语义
			*
			* 传 `null` = 宿主语义上的"回到 Conversation"
			* （`ui-layout/src/client/service.ts:68-74`：`panelId === null` 时跳过
			* `hasMainPanel` 校验并直接 `panels.selectPanel(null)`）。
			* 这是**唯一**合法的"关掉中央面板"路径 —— 面板本身不是开关，选中权在宿主布局里。
			*
			* ## 诊断
			*
			* 两条解析通路都试（`ctx.get` 与 `ctx.layout`），任一可用即成功。
			* 全失败时给出**可操作**的 console 警告而非静默吞掉 —— 静默失败正是本缺陷潜伏的原因。
			*/
			const resolveLayout = () => {
				try {
					const viaGet = ctx.get("layout");
					if (typeof viaGet?.selectPanel === "function") return viaGet;
				} catch {}
				try {
					const direct = ctx.layout;
					if (typeof direct?.selectPanel === "function") return direct;
				} catch {}
			};
			const close = () => {
				try {
					const layout = resolveLayout();
					if (typeof layout?.selectPanel !== "function") {
						console.warn("[dsh-tfs-requirment] 无法关闭面板：宿主 layout 服务不可用。请确认 dsh 客户端已加载 ui-layout；若右侧栏按钮有效但此处无效，说明该部署未提供 ctx.layout.selectPanel。");
						return;
					}
					layout.selectPanel(null);
				} catch (e) {
					console.warn("[dsh-tfs-requirment] 关闭面板失败：", e);
				}
			};
			slots.inject("sidebar.panellist", () => registerOnce(slots, {
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 50,
				label: PANEL_LABEL
			}, TfsPanelIcon));
			slots.inject("main", () => registerOnce(slots, {
				name: "main",
				key: PANEL_ID,
				children: { [TFS_CHAT_SLOT_KEY]: {
					kind: "single",
					scope: "session"
				} }
			}, (slotProps) => {
				const kit = slotProps;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Workbench, {
					ctx,
					onClose: close,
					chatKit: {
						...kit.SessionProvider ? { SessionProvider: kit.SessionProvider } : {},
						...kit.renderSlot ? { renderSlot: kit.renderSlot } : {},
						childKey: TFS_CHAT_SLOT_KEY
					}
				});
			}));
			slots.inject(TFS_CHAT_SLOT_KEY, () => registerOnce(slots, { name: TFS_CHAT_SLOT_KEY }, (slotProps) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OrchestratorChatBody, { ...slotProps })));
			ctx.effect(() => watchPanelRow(slots), "tfs-requirment: watch sidebar.panellist");
			slots.inject("sidebar.footer.action", () => registerOnce(slots, {
				name: "sidebar.footer.action",
				id: PANEL_ID,
				label: PANEL_LABEL
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TfsFooterEntry, {})));
			slots.inject("shell.overlay", () => registerOnce(slots, {
				name: "shell.overlay",
				id: PANEL_ID
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TfsOverlayEntry, { ctx })));
			registerSideTab(ctx);
		}
		/**
		* 旧 / 精简宿主：`sidebar.footer.action`（list, root）里的 TFS 入口按钮。
		* 点击经 {@link panelOpen}.show() 打开 shell.overlay 中的全屏面板。
		*
		* 菜单行（`sidebar.panellist`）已注册时返回 `null` —— 那时用户已有一条正规入口，
		* 本按钮就是重复的第二个「TFS 看板」（2026-10-08）。返回 null 而非不注册，
		* 是为了保持 `registerOnce` 的重跑语义与 disposer 链路完整。
		*/
		function TfsFooterEntry() {
			if ((0, react.useSyncExternalStore)(panelRowRegistered.subscribe, panelRowRegistered.getSnapshot)) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				title: PANEL_LABEL,
				"aria-label": PANEL_LABEL,
				onClick: () => panelOpen.show(),
				style: {
					width: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 6,
					padding: "8px",
					border: "none",
					borderRadius: 8,
					background: "transparent",
					color: "inherit",
					cursor: "pointer"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TfsPanelIcon, { size: 18 })
			});
		}
		/**
		* 旧 / 精简宿主：`shell.overlay`（list, root）里的 TFS 全屏面板。
		* overlay 层本身 click-through、其直接子元素自动获得 pointer-events；
		* 默认关闭时返回 null（不会开机即盖住应用），打开时渲染遮罩 + Workbench，
		* 点遮罩、Workbench 的关闭按钮或 Esc 收口到 {@link panelOpen}.hide()。
		*/
		function TfsOverlayEntry(props) {
			const open = (0, react.useSyncExternalStore)(panelOpen.subscribe, panelOpen.getSnapshot);
			const hasPanelRow = (0, react.useSyncExternalStore)(panelRowRegistered.subscribe, panelRowRegistered.getSnapshot);
			if (!open || hasPanelRow) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "dialog",
				"aria-modal": "true",
				"aria-label": PANEL_LABEL,
				onClick: () => panelOpen.hide(),
				style: {
					position: "absolute",
					inset: 0,
					background: "rgba(17,24,39,0.45)",
					display: "flex",
					alignItems: "stretch",
					justifyContent: "center",
					padding: 24
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					onClick: (e) => e.stopPropagation(),
					style: {
						flex: 1,
						maxWidth: 1400,
						borderRadius: 12,
						overflow: "hidden",
						background: "#fff",
						boxShadow: "0 20px 60px rgba(0,0,0,0.35)"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Workbench, {
						ctx: props.ctx,
						onClose: () => panelOpen.hide()
					})
				})
			});
		}
		/**
		* 注册右侧栏「TFS 执行」标签页（优化项 R1：与对话并排的执行配置）。
		*
		* ## 为什么必须走官方注册表，而不是自己往 DOM 里塞
		*
		* 右栏是宿主自己管理的停靠系统（分屏 / 浮动 / 拖拽 / 每会话一份布局），
		* DOM 注入进去的节点在宿主每次重排时都会被丢弃，且拿不到 `openTab` / `focus` / `close` 语义。
		* 宿主为此显式开放了两段式协议（见 `SidePanel.tsx` 文件头的 file:line 依据）：
		*   ① `ctx.sidebarRightTabs.register({ id, kind, title, guide })`；
		*   ② 该 `id` 再注册进 `sidebar.right.pane.tab` 槽。
		*
		* ## 为什么整块包在 try/catch 里
		*
		* `sidebarRightTabs` 与 `sidebarRight` 都是**较新**的宿主服务（本机 0.1.5-rc.2 有，
		* 但更老的部署可能没有）。右栏是这个插件的**增强**形态，不是它的唯一入口——
		* 拿不到服务时应当安静退化成"只有中央看板"，而不是把整套 UI 一起拖死。
		*
		* 注意这里用 `ctx.get()`（非抛出）而非把它加进 `inject`：`inject` 缺服务会让插件
		* **加载失败**，那才是真正的拖死。
		*
		* @param ctx - 客户端根上下文。
		*/
		function registerSideTab(ctx) {
			try {
				const tabs = ctx.get("sidebarRightTabs");
				if (tabs === void 0 || typeof tabs.register !== "function") return;
				const slots = ctx.slots;
				/**
				* 声明页类型。
				*
				* `title` 在**打开时**被读取并固化进布局记录，故给固定文案即可
				* （与 `SidebarRightTabDefinition.title` 的契约一致）。
				* `guide` 让该类型出现在右栏 `+` 的向导页里——没有它，用户只能靠
				* `openTab(kind)` 从代码打开，等于"注册了但没人知道怎么进"。
				*/
				const dispose = tabs.register({
					id: TFS_EXEC_TAB_ID,
					kind: TFS_EXEC_KIND,
					title: () => TFS_EXEC_TITLE,
					guide: [{
						title: () => TFS_EXEC_TITLE,
						description: () => "与对话并排配置执行参数、派发看板任务"
					}]
				});
				ctx.effect(() => dispose, "tfs-requirment: sidebar-right tab type");
				/**
				* 页体。key 必须等于 `definition.id`：注册表文档明写
				* "it is the key its body and title register under in the
				* `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats"。
				*
				* ⚠️ `sidebarRight` **必须在此回调内解析**（不能提到 `registerSideTab` 顶部并闭包捕获）：
				* 该服务与 `sidebarRightTabs` 同批提供，而 `slots.inject` 的回调在槽就绪后才跑 ——
				* 提到顶部会在宿主服务尚未激活时取到 `undefined` 并被永久闭包捕获，
				* 导致"关闭/收起按钮点了没反应"（同一类缺陷，见 `close()` 的注释）。
				*/
				slots.inject("sidebar.right.pane.tab", () => registerOnce(slots, {
					name: "sidebar.right.pane.tab",
					key: TFS_EXEC_TAB_ID
				}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SidePanel, {
					bridge,
					boardStore,
					onClose: () => {
						try {
							ctx.get("sidebarRight")?.toggleExpanded?.();
						} catch {}
					}
				})));
			} catch {}
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* 客户端模块名。与宿主半的 `tfs-requirment` 区分开，便于日志定位。
		* DSH 客户端契约只认命名导出 `name`/`inject`/`apply`（对齐 dsh-optimized-prompt/client），
		* 因此**不要**再加 `export default`——那会触发 tsdown 的 MIXED_EXPORTS 并让加载器可能取到 `default`。
		*/
		const name = "tfs-requirment-client";
		/** 本插件客户端半所需的 cordis 服务。 */
		const inject = ["slots"];
		/**
		* 客户端半入口：宿主在 web 平台加载 "./client" 时调用。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			registerExecutionPanel(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map