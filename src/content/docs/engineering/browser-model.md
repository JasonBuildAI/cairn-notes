---
title: 浏览器与前端运行模型
description: 从 HTML、CSS、JavaScript 到渲染、类型和存储，理解页面怎样变成可交互应用。
---

浏览器不是“显示 HTML 的软件”，而是一套运行环境：它下载资源、解析文档、计算样式、布局、绘制、执行 JavaScript、管理网络与存储，还要约束不同网站之间的权限边界。前端框架只是建立在这套运行环境上的组织方式。

理解浏览器模型后，很多问题会自然分开：页面结构不对是 DOM 问题，样式错位是布局问题，点击没反应是事件或脚本问题，白屏可能是资源加载、脚本异常或渲染失败，接口成功但界面不更新则可能是状态管理问题。

## 1. 浏览器的角色分工

一个页面通常涉及以下能力：

| 能力 | 负责什么 |
| --- | --- |
| 网络栈 | DNS、连接、TLS、HTTP、缓存、Cookie |
| HTML 解析器 | 把文档变成 DOM |
| CSS 引擎 | 解析样式、计算层叠与布局 |
| JavaScript 引擎 | 解析并执行脚本、管理内存 |
| 渲染引擎 | 布局、绘制、合成、动画 |
| 存储 | Cookie、Local Storage、IndexedDB、Cache Storage |
| 安全边界 | 同源策略、权限、沙箱、站点隔离 |

浏览器通常不是单个进程。为了稳定和安全，不同页面、站点或渲染任务可能被放在不同进程中。JavaScript 主线程负责大部分脚本和渲染工作，主线程被长任务占满时，即使网络很快，页面也会卡顿。

## 2. 一次页面导航经历了什么

在地址栏输入 URL 后，大致流程是：

```text
URL 解析
  → DNS 查 IP
  → TCP 连接
  → TLS 握手（HTTPS）
  → 发送 HTTP 请求
  → 接收 HTML、CSS、JS、图片等资源
  → 构造 DOM 与 CSSOM
  → 渲染树 → 布局 → 绘制 → 合成
  → 执行脚本，页面进入可交互状态
```

浏览器并不会等所有资源下载完才显示页面。HTML 解析、CSS 加载、脚本执行和图片解码可能交错进行。某个资源会阻塞什么，取决于资源类型和属性。

### 2.1 DOM 与 CSSOM

HTML 解析器把标签转换为 **DOM（Document Object Model）**。DOM 是树状对象模型，不只是文本：元素、属性、文本节点都可以被 JavaScript 查询和修改。

```html
<main class="page">
  <h1>标题</h1>
  <p>正文</p>
</main>
```

对应结构大致是：

```text
document
└── main.page
    ├── h1
    │   └── "标题"
    └── p
        └── "正文"
```

CSS 被解析为 **CSSOM**。浏览器结合 DOM 与 CSSOM 计算每个元素的最终样式，再生成渲染树。`display: none` 的元素通常不会进入渲染树；`visibility: hidden` 仍占据布局空间。

### 2.2 布局、绘制与合成

- **布局（layout/reflow）**计算每个盒子的位置和尺寸。
- **绘制（paint）**把文字、背景、边框、阴影等画到图层。
- **合成（composite）**把多个图层按顺序合并成屏幕像素。

改变宽高、字体、位置或内容常常触发布局；改变颜色或背景多半只需要重绘；修改 `transform` 和 `opacity` 可能只需要合成，但具体仍取决于浏览器和元素是否形成独立图层。

频繁读取布局属性再写样式，会造成**布局抖动**：

```js
// 每次循环都读 offsetHeight，可能强制同步布局
for (const item of items) {
  item.style.width = `${container.offsetWidth / 2}px`;
}
```

更稳妥的方式是先读、后写，或把多次修改合并到一次渲染。

### 2.3 脚本加载

普通 `<script>` 会阻塞 HTML 解析，因为脚本可能修改文档。`defer` 让脚本在文档解析完成后、按顺序执行；`async` 让脚本下载完成后尽快执行，但不保证顺序。

```html
<script src="app.js" defer></script>
<script src="analytics.js" async></script>
```

样式表也可能阻塞渲染，因为浏览器不希望先画出无样式内容再突然重排。关键 CSS 应尽快送达，非关键脚本应避免阻塞首屏。

## 3. HTML：先表达结构，再谈样式

HTML 的核心不是“div 布局”，而是语义和文档结构。正确的元素能带来默认行为、键盘操作和辅助技术识别。

| 元素 | 适合表达 |
| --- | --- |
| `header`、`nav`、`main`、`footer` | 页面区域 |
| `h1`–`h6` | 标题层级 |
| `p`、`ul`、`ol` | 段落和列表 |
| `button` | 可点击操作 |
| `a` | 导航到另一个地址 |
| `form`、`label`、`input` | 表单输入与关联 |
| `table` | 行列数据，不用于整页布局 |
| `img` 的 `alt` | 图片替代文本 |

按钮和链接不能只靠 `div` 加点击事件替代。原生按钮自带键盘焦点、空格/回车触发和禁用状态；链接负责导航。语义错误会让键盘用户和屏幕阅读器无法正常使用。

### 3.1 表单与输入边界

```html
<form>
  <label for="email">邮箱</label>
  <input id="email" name="email" type="email" required />
  <button type="submit">保存</button>
</form>
```

浏览器能做基础格式校验，但服务端仍必须验证。`required`、`min`、`max` 和 `pattern` 是用户体验与第一道检查，不是安全边界。

## 4. CSS：层叠、盒模型与布局

CSS 规则由选择器、属性和值组成。多个规则命中同一元素时，浏览器按来源、重要性、层叠层、选择器优先级和书写顺序决定结果。

```css
.card {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 8px;
}

.card[hidden] {
  display: none;
}
```

### 4.1 盒模型

每个元素可以看成一个盒子，由内容、内边距、边框和外边距组成。默认 `box-sizing: content-box` 时，设置 `width` 只控制内容宽度；设置 `box-sizing: border-box` 后，宽度包含内边距和边框。

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
```

实际宽度、可用空间和滚动条都会影响布局。调试时看浏览器计算后的盒模型，比只看源码更可靠。

### 4.2 正常流、定位与层叠

- `display: block` 元素通常独占一行；`inline` 元素按文本流排列。
- `position: static` 是正常流；`relative` 相对自身偏移；`absolute` 相对最近的定位祖先；`fixed` 相对视口；`sticky` 在阈值内参与滚动。
- `z-index` 只在同一层叠上下文中比较。父元素创建新层叠上下文后，子元素的 `z-index` 不会跨上下文任意压过其他元素。
- `overflow` 决定内容超出盒子时是否裁剪或滚动。

定位元素常被用来做浮层、下拉菜单和提示框，但它们会脱离正常流，可能遮挡内容、影响键盘焦点和移动端滚动。能用 flex/grid 完成的布局，不必优先使用绝对定位。

### 4.3 Flexbox 与 Grid

Flexbox 适合一维排列：一行或一列中的项目如何分配空间、对齐和换行。

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar .search {
  flex: 1 1 auto;
  min-width: 0;
}
```

`min-width: 0` 常用于让 flex 子项真正收缩，否则内容可能撑破容器。

Grid 适合二维布局：同时控制行和列。

```css
.layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 24px;
}
```

`minmax(0, 1fr)` 可以避免内容把网格列撑得过宽。响应式布局通常结合媒体查询、相对单位和 `clamp()`，而不是为每个设备写一套完全独立的页面。

### 4.4 继承、变量与层叠

部分属性会从父元素继承，例如字体和颜色；盒模型、定位等通常不会。CSS 自定义属性可以定义主题变量：

```css
:root {
  --text: #1f2937;
  --surface: #ffffff;
}

.panel {
  color: var(--text);
  background: var(--surface);
}
```

变量值仍然遵循层叠规则。组件库覆盖样式时，先确认是选择器优先级、加载顺序还是层叠上下文导致，不要无脑增加 `!important`。

## 5. JavaScript 运行时

JavaScript 语言规范定义语法、类型和语义；浏览器提供 DOM、fetch、定时器、存储等宿主 API。Node.js 也执行 JavaScript，但宿主 API 不同，没有 DOM，提供的是文件、进程和网络服务接口。

### 5.1 值、作用域与闭包

JavaScript 的基本类型包括 `string`、`number`、`bigint`、`boolean`、`undefined`、`symbol` 和 `null`；对象和数组是引用类型。对象赋值复制的是引用，不会自动深拷贝。

`let` 和 `const` 有块级作用域，`var` 是函数作用域并存在变量提升。理解作用域后，闭包就是一个函数记住了它定义时所在的作用域：

```js
function createCounter() {
  let count = 0;
  return () => ++count;
}

const next = createCounter();
next(); // 1
next(); // 2
```

闭包常用于封装状态和回调，也可能让不再需要的大对象无法被回收。内存问题要结合实际引用关系分析。

### 5.2 this、原型与类

`this` 取决于函数怎样被调用：普通调用、对象方法调用、显式 `call/apply/bind`、构造函数和箭头函数各有规则。箭头函数没有自己的 `this`，会捕获外层作用域。

JavaScript 的对象通过原型链查找属性和方法。`class` 语法提供更熟悉的组织方式，但底层仍然涉及原型。继承层级过深会让行为难以追踪；组合和清晰边界通常比“继承一切”更容易维护。

### 5.3 事件循环

JavaScript 主线程一次只执行一段同步代码。异步任务进入任务队列或微任务队列，当前调用栈清空后，事件循环协调执行顺序。

```js
console.log("A");
setTimeout(() => console.log("B"), 0);
Promise.resolve().then(() => console.log("C"));
console.log("D");
// A D C B
```

`setTimeout(0)` 不是立即执行，而是至少排到后面的任务；Promise 回调属于微任务，通常在当前任务结束后、下一次渲染或定时任务前执行。大量微任务仍可能阻塞页面。

`async/await` 让 Promise 更像同步代码，但不会把 CPU 计算变成并行。一个长循环仍然会阻塞主线程；需要把大任务拆分，交给 Web Worker，或移到服务端。

### 5.4 Promise 与错误

```js
async function loadUser(id) {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
```

`fetch` 只有在网络层失败或某些 CORS 情况下才抛出异常，HTTP 404/500 不会自动 reject，必须检查 `response.ok`。异步错误需要 `try/catch` 或被统一错误边界捕获。

### 5.5 DOM 与事件

```js
const button = document.querySelector("#save");
button.addEventListener("click", async (event) => {
  event.preventDefault();
  button.disabled = true;
  try {
    await save();
  } finally {
    button.disabled = false;
  }
});
```

事件通常从目标元素冒泡到祖先，也可以捕获阶段处理。大量子元素需要共用一个处理器时，可以在父级监听，通过 `event.target` 或 `closest()` 判断来源，这叫事件委托。

移除事件监听、取消定时器和中止请求都很重要。单页应用反复挂载组件却不清理，会导致重复回调、内存上涨和难以解释的行为。

## 6. TypeScript：编译期约束，不是运行时保证

TypeScript 在 JavaScript 上增加静态类型检查。它帮助发现字段名拼错、参数不匹配、空值未处理和部分重构遗漏，但类型在编译后基本被擦除。

```ts
type OrderStatus = "pending" | "paid" | "cancelled";

interface Order {
  id: string;
  status: OrderStatus;
  totalCents: number;
}
```

常用能力：

- **类型推断**：根据赋值和返回值自动推导类型。
- **联合类型与收窄**：`string | undefined` 通过判空后缩小范围。
- **泛型**：让函数和数据结构复用，同时保留类型关系。
- **结构化类型**：只要对象形状满足接口，就可以被接受。
- **`unknown`**：表示未知输入，必须先检查才能使用；比 `any` 安全。

```ts
function formatTotal(order: Order): string {
  return `¥${(order.totalCents / 100).toFixed(2)}`;
}
```

不要用 `as` 强制断言绕过所有检查。来自 `fetch`、表单、消息队列或本地存储的数据仍是未知值，应使用运行时 schema 校验：

```ts
const data: unknown = await response.json();
if (!isOrder(data)) throw new Error("invalid order");
```

TypeScript 配置中的 `strict` 能捕获更多问题，但会对旧代码暴露大量错误；渐进式启用比直接关闭检查更可靠。

## 7. 浏览器存储与缓存

| 方式 | 容量与生命周期 | 适合 |
| --- | --- | --- |
| Cookie | 小，随请求发送，可设置过期 | 会话标识、有限状态 |
| localStorage | 较大，持久，同步 API | 少量非敏感偏好设置 |
| sessionStorage | 标签页会话级 | 临时表单或页面状态 |
| IndexedDB | 大，异步，结构化数据 | 离线数据、大量客户端记录 |
| Cache Storage / Service Worker | 由缓存策略控制 | 资源缓存、离线体验 |

Cookie 的 `HttpOnly`、`Secure`、`SameSite` 会影响安全和跨站行为。`localStorage` 容易被脚本读取，不应保存长期令牌或敏感个人信息。浏览器存储不是服务端数据库，容量、清理策略和多设备一致性都不可靠。

HTTP 缓存由 `Cache-Control`、`ETag`、`Last-Modified` 等头部控制。静态资源可以使用带内容哈希的文件名并长缓存；HTML 通常需要更谨慎的缓存策略，避免用户长期看到旧入口。

## 8. 图形与动画

- **CSS 动画**适合简单的位移、透明度和颜色变化，能利用浏览器合成。
- **SVG**适合图标、图表和可缩放矢量图形，DOM 可交互。
- **Canvas**适合大量像素绘制、游戏和实时可视化，但内容不是天然可访问的 DOM。
- **WebGL / WebGPU**适合高性能 2D/3D 渲染，复杂度和兼容性更高。

动画性能的关键不是“用了哪个 API”，而是每帧做了多少工作。优先动画化 `transform` 和 `opacity`，避免每帧读写布局；使用 `requestAnimationFrame` 与浏览器刷新节奏同步。对于需要减少动态效果的用户，应尊重 `prefers-reduced-motion`。

## 9. 前端请求与安全边界

浏览器中的请求受同源策略约束。协议、域名和端口任一不同都算跨源。CORS 是服务器允许浏览器读取跨源响应的机制，不是访问控制本身；服务端仍必须验证身份和权限。

需要区分的概念：

- 跨域请求可以发出，但浏览器可能阻止脚本读取响应。
- CORS 预检（OPTIONS）处理非简单请求的权限协商。
- CSRF 利用浏览器自动携带 Cookie 的行为，防护常依赖 SameSite、CSRF token 和正确的请求方法。
- XSS 让攻击者在页面中执行脚本，应通过输出编码、可信模板和内容安全策略降低风险。
- 前端隐藏按钮不等于授权，所有敏感操作必须在服务端重新检查。

## 10. 页面问题怎样分层

| 现象 | 优先检查 |
| --- | --- |
| 白屏 | HTML 是否返回、脚本是否报错、资源是否 404 |
| 样式错乱 | CSS 是否加载、选择器是否命中、盒模型与层叠 |
| 点击无反应 | 事件是否绑定、元素是否被遮挡、脚本是否中断 |
| 数据不更新 | 请求是否成功、状态是否更新、组件是否重渲染 |
| 首屏慢 | 资源体积、阻塞脚本、关键 CSS、图片与字体 |
| 滚动卡顿 | 主线程长任务、布局抖动、过多 DOM 或绘制 |
| 刷新后状态丢失 | 内存状态未持久化、存储策略或缓存问题 |
| 跨域失败 | CORS、Cookie、SameSite、预检和代理配置 |

## 检查清单

- HTML 是否表达正确语义，而不只是堆 `div`。
- 页面是否能在不同宽度和键盘操作下使用。
- CSS 布局是否理解正常流、盒模型和层叠上下文。
- JavaScript 是否正确处理异步错误、取消和清理。
- 是否区分同步代码、微任务、宏任务和真正的并行计算。
- TypeScript 类型是否覆盖边界，运行时输入是否仍然校验。
- 浏览器存储是否只保存合适的数据，敏感信息是否处理正确。
- 静态资源与 HTML 是否采用了匹配的缓存策略。
- 网络请求是否考虑跨域、鉴权、超时和取消。
- 性能问题是否先用 Performance 面板定位，而不是盲目减少代码。
