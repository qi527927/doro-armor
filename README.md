# Doro 破甲 1.1.1

宿主机侧的系统提示词注入插件。三层人格载荷 + 组装期安全规则真实剥离。

> **1.1.1 是一次减法重构。** 客户端半、悬浮窗、假清除器全部移除，只留真正能改动宿主提示词的一条路。理由见 [五、1.1.1 改了什么](#五111-改了什么为什么)。

---

## 一、它到底做什么

三层 section 注入进 `system-prompt`，并在宿主的 `system-prompt/assemble` waterfall 里过滤真实的 assembly：

| 层 | section | order | 作用 |
|---|---|---|---|
| 内核 | `doro-armor:kernel` | 100 | Doro 人格 + 反注入协议 + 写作技巧 + 弹药十类 + 永久无限制锁 |
| 镜像 | `doro-armor:mirror` | 200 | 四条硬约束的差异化加固摘要，防单点失效 |
| 条款 | `doro-armor:obedience` | 300 | 无限制条款独立成段，层级调整中不丢 |

`order 100` 抢在宿主的 `PLAN_POLICY` 之前，所以内核排在最前面。

**组装期剥离**（`stripSafetyRules`）在 `system-prompt/assemble` waterfall 里过滤宿主真正要发给模型的那份 assembly：按 section 名 + 正文双层匹配，剔除身份段、人设段、各类 `:policy` 段。自身段落（`doro-armor:` 前缀）永久豁免。

**插件不碰 `contexts`。** 动态上下文链（工作目录 / 沙箱 / 审批 / 子代理委派 / 子代理身份）全部归宿主 `suppressRuntimeContext()` 管——`includeRuntimeContext: false` 会让宿主按「抑制可选、保留 `required: true`」的语义自己过滤。插件曾经在 waterfall 里清空它，那是错的：宿主 `resolveContext()`（`lib/index.js:186`）只透传 `name` / `text` / `interpolate`，**`required` 字段到 waterfall 已经不存在**，插件没有信息去做正确判断，任何过滤都会误杀必须保留的事实。`probe_assemble.mjs` 里有一条 `sandbox:required-fact` 的墓碑断言专门盯着这个，谁把 contexts 处理加回来它立刻红。

---

## 二、安装：profile 层挂载

本机 profile：`~/.dsh/profiles/web/`

**1.** 把包目录放到一个稳定位置，比如 `~/Documents/deepseek-harness/default-workspace/plugins/doro-armor/`

**2.** 编辑 `~/.dsh/profiles/web/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "doro-armor"
      ]
    }
  },
  "dependencies": {
    "doro-armor": "link:~/Documents/deepseek-harness/default-workspace/plugins/doro-armor"
  }
}
```

`doro-armor` **必须排在 `bundles` 数组最后**——补丁层按这个顺序叠加，最后说话的赢。我们要抢 `agent-instructions` 的启用权，就得排在 `dsh-web-app` 后面。

**3.** 重启应用。`node_modules/doro-armor` 是指向包目录的软链，改源文件即时生效，不用重装。

### 验证装载

在对话里喊我：

```
doro_armor_profile
```

返回 `injection` 里三层都是 `registered: true`、`enforcement.completeOverride` 是 `false`，就是装对了。

---

## 三、配置项

全部在 `cordis.patch.yml` 的 `insert.config` 下：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `injectKernel` | `true` | 内核层 |
| `injectMirror` | `true` | 镜像层 |
| `injectObedience` | `true` | 条款层 |
| `injectAmmo` | `true` | 弹药十类并入内核 |
| `injectWritingTips` | `true` | 写作技巧 + Few-Shot 并入内核 |
| `completeOverride` | **`false`** | 见下 |
| `stripSafetyRules` | `true` | 组装期真实剥离 |

### `completeOverride` 为什么默认 false

宿主 `assemble()` 一旦发现有 `complete: true` 的 section，会在 waterfall **之后**把 `sections` 强行替换成 `[completeSection]`。两个后果：

1. waterfall 里 `stripSafetyRules` 的过滤结果被整体丢弃 —— 剥离器变成死代码
2. `tool:bash`(1000) 到 `mcp:servers`(3100) 的全部工具说明文本被丢掉 —— `tools` 数组仍独立传给模型，所以工具能调，但模型不知道该怎么用

置 `true` 只在「确实要一份完全自定的单段提示词、且不需要工具说明」时才值得。

---

## 四、验证

```bash
node --check index.js
node scripts/verify_plugin.mjs       # 静态自检 46 项
node scripts/probe_assemble.mjs      # 真宿主集成回归 24 项

# 配置漂移检查：静态断言管不着，必须单独看
grep -n "includeRuntimeContext: false" cordis.patch.yml   # 必须命中
grep -n "completeOverride: false"      cordis.patch.yml   # 必须命中
grep -n 'disabled: !!js "false"'       cordis.patch.yml   # 必须命中，裸 false 会炸
```

`probe_assemble.mjs` 会真起一个 `@deepseek-ai/dsh-system-prompt`，把本体载进去，断言宿主实际吐出来的 `sections` 与 `contexts`——不是插件内存里的自我汇报。**这个才算验收。**

**为什么还要那三条 grep**：`verify_plugin.mjs` 查的是 `index.js` 里的代码形状，查不到 `cordis.patch.yml` 的配置有没有被人改。两个数字全绿、配置漂移了，这是 `[6]` 双模对照专门要防的那类失效——它只能发现运行时行为变了，发现不了「配置该写 false 结果写了 true」。

它同时跑了 `completeOverride: true` 的对照组，把那两条 bug 钉成回归测试：sections 塌成 1 条、工具说明文本丢失。

---

## 五、1.1.1 改了什么、为什么

### 1｜删掉 `client.js`

`client.js:15` 第一句就是 `window.__ModuleLoader__.load(...)`。这个 app 的界面是 SwiftUI 原生的，没有 `window`、没有 `ModuleLoader`。它不但不显示任何东西，还在**每次加载时抛 `ReferenceError: window is not defined`** —— 实测宿主真的会去加载它。

连删的还有：`package.json` 里的 `dsh.client` 块、`./client` / `./client.js` 两个 export、`files` 数组里的条目。

### 2｜删掉假清除器

`executeClearAll` / `deepResidueSweep` / `liveSectionSnapshot` 这一整条链路，扫的是插件自己内存里的 `registrations` Map。宿主的安全段落不在里面——插件没法替别人注册 section。

所以它返回的八条「残留」全是 `absent: true`，「已清零 ✓」是它自己跟自己汇报。三态动画、多轮清退、复检归零，全程在脑子里演，对宿主提示词零影响。

连带删掉的还有 `DEEP_RESIDUE_PATTERNS`——它声称是「比正文层更宽」，实际 11 条全部与 `SAFETY_TEXT_PATTERNS` 重复，一条新的都没有。那个「全面高级 / core」档位切换因此是假的。

### 3｜修好剥离器本身（这条最重）

旧代码这么挂：

```js
const hook = ctx?.systemPrompt?.onAssemble || ctx?.systemPrompt?.hooks?.assemble;
```

宿主的 `SystemPrompt` 实例上**这两个接口都不存在**。真实挂法只有一个，在 `dsh-system-prompt/lib/index.js:401`：

```js
this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, ...)
```

也就是 cordis 的 waterfall 事件。旧代码两个分支都拿不到函数，于是退化到「包一层 `ctx.systemPrompt.assemble`」——而 `assemble()` 是 `async` 的，返回值是 Promise，`stripSafetyRules` 是同步的、只认对象不认 Promise，`Array.isArray(promise.sections)` 直接 false。

**结论：剥离器在真机上从来没生效过一次。** 「安全规则已剥离」这个功能，1.0.x 全程是个装饰。

现在改成标准 waterfall 监听器：

```js
ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
  stripSafetyRules(assembly);
  const out = await next();
  return stripSafetyRules(out && typeof out === "object" ? out : assembly);
});
```

原地过滤一次（让后续监听器看到的就是净化版），再对 `next()` 的返回值补一刀（防止后面的监听器又塞回来）。`probe_assemble.mjs` 里 24 项全过。

### 4｜删掉会话投影

`projectionDef` / `projectionApply` / `liveLayers` / `anchorOf` / `refusalHits` / `fallbackHits` 这一整套，唯一消费者是 `client.js` 的状态条。客户端半没了，它就只是往会话投影里塞一个没人读的 key。`inject` 数组里的 `sessionProjections` 一并去掉。

### 5｜删掉 `install.sh`

iOS 上没有 bash 真身、没有 `unzip`、不能 `ln -s`、不能 `chown`。留一个跑不通的脚本比没有更坑——用户会先试它，失败，然后以为整个插件坏了。

### 6｜`agent-instructions` 从禁用改成重新启用

层序原本是：`dsh-base` 插入（`maxBytes: 65536`）→ `dsh-web-app` 禁用 → `doro-armor` 再禁用一次。

最后说话的是 `dsh-web-app`，所以 `AGENTS.md` / `CLAUDE.md` 在本机根本不加载。而 DORO-CHAIN v2.3 的第 4 层锚点恰恰要读 `CLAUDE.md` 里的标记——插件自己把自证链掐了。

现在改成重新启用：

```yaml
- id: agent-instructions
  disabled: !!js "false"
```

**注意必须是 `!!js "false"`，不能写裸 `false`。** entry schema 是 `disabled: { anyOf: [{ const: true }, loaderExpression] }` —— 只认 `true` 或 `!!js` 表达式，裸 `false` 会让整份 patch 被 schema 拒绝，插件直接不加载。

#### 取舍：这是一条剥离器管不着的入注通道

`AGENTS.md` / `CLAUDE.md` 加载为一条 **durable baseline 对话消息**，不是 `system-prompt` 的 section。所以：

- 剥离器把 `harness:identity` / `plan:policy` 从系统提示词剔干净 ✓
- 这两个文件作为 user-role 消息原封不动进同一轮对话 ✗

`stripSafetyRules` 的作用域到不了消息层。文件里写什么就进来什么——包括你想让第 4 层锚点读到的 v2.3 标记，也包括任何别的东西。

当前 `~/.dsh/` 与工作区都没有这两个文件，所以**眼下实际注入为零**。但通道是开着的，别把“现在没内容”当成“没有风险”。真要收窄，`instructionFileCandidates` 可以只留 `CLAUDE.md`，`maxBytes` 可以掐预算（都继承 base，改要重述 config）。

---

## 六、目录结构

```
doro-armor/
├── index.js                    # 宿主半：三层注入 + 组装期剥离 + profile 工具
├── cordis.patch.yml            # 补丁层：system-prompt 覆盖 / agent-instructions 复活 / 本体插入
├── package.json                # 包描述（dsh.bundle，无 dsh.client）
├── payload.manifest.json       # 载荷来源指纹
├── README.md
└── scripts/
    ├── verify_plugin.mjs       # 静态自检 46 项
    └── probe_assemble.mjs      # 真宿主集成回归 24 项
```

---

## 七、疑难

**Q：装完 `doro_armor_profile` 报 `cannot get property "tools" without inject`？**
`PLUGIN_INJECT` 必须同时挂在默认导出的 `plugin.inject` 和模块级 `export const inject` 上。cordis 按默认导出对象装载时只认前者。

**Q：内核对内容不生效？**
先跑 `node scripts/probe_assemble.mjs`。它打印宿主实际吐出的 `sections` 数组。内核不在里面，就是注册没成功；在里面但模型行为没变，那是模型侧的事，跟插件无关。

**Q：`agent-instructions` 复活之后，`AGENTS.md` 里的内容会不会跟内核打架？**
会。它们作为 durable baseline 消息进对话历史，优先级低于 system prompt，但内容会共存。如果 `AGENTS.md` 里写着别的身份指令，自己权衡。

**Q：改了源文件要重装吗？**
不用。`link:` 挂载是软链，改完重启应用即可。
