---
title: "Browser and Front-End Execution Model"
description: "From HTML, CSS, and JavaScript to rendering, types, and storage, understand how a page becomes an interactive application."
---

A browser is not just "software that displays HTML," but a runtime environment: it downloads resources, parses documents, computes styles, handles layout, paints, executes JavaScript, manages network and storage, and also enforces permission boundaries between different websites. Front-end frameworks are merely ways of organizing work on top of this runtime environment.

Once you understand the browser model, many issues naturally fall into place: incorrect page structure is a DOM problem, misaligned styles are a layout issue, unresponsive clicks are event or script problems, a blank screen might result from resource loading, script errors, or rendering failures, and if an API succeeds but the interface doesn't update, it could be a state management problem.

## 1. Division of Roles in the Browser

A page typically involves the following capabilities:

| Capability | Responsibilities |
| --- | --- |
| Network Stack | DNS, connection, TLS, HTTP, caching, cookies |
| HTML Parser | Converts documents into the DOM |
| CSS Engine | Parses styles, computes cascading and layout |
| JavaScript Engine | Parses and executes scripts, manages memory |
| Rendering Engine | Layout, painting, compositing, animation |
| Storage | Cookies, Local Storage, IndexedDB, Cache Storage |
| Security Boundaries | Same-origin policy, permissions, sandboxing, site isolation |

Browsers are usually not a single process. For stability and security, different pages, sites, or rendering tasks may be placed in separate processes. The JavaScript main thread handles most scripting and rendering work. If the main thread is occupied by long tasks, the page will lag even if the network is fast.

## 2. What Happens During a Page Navigation

After entering a URL in the address bar, the general process is:

```text
URL Analysis
  → DNS check IP
  → TCP connection
  → TLS Handshake (HTTPS)
  → send HTTP request
  Receive HTML, CSS, JS, images, and other resources
  → Construct DOM and CSSOM
  → Render Tree → Layout → Paint → Compositing
  Execute the script, and the page becomes interactive
```

The browser does not wait for all resources to be downloaded before displaying the page. HTML parsing, CSS loading, script execution, and image decoding may occur in an interleaved manner. What a particular resource blocks depends on its type and attributes.

### 2.1 DOM and CSSOM

The HTML parser converts tags into the **DOM (Document Object Model)**. The DOM is a tree-like object model, not just text: elements, attributes, and text nodes can all be queried and modified by JavaScript.

```html
<main class="page">
  <h1>Title</h1>
  <p>Main text</p>
</main>
```

The corresponding structure is roughly:

```text
document
└── main.page
    ├── h1
    │   └── "Title"
    └── p
        Main text
```

CSS is parsed into **CSSOM**. The browser combines the DOM and CSSOM to calculate the final style of each element, then generates the render tree. Elements with `display: none` usually do not enter the render tree; `visibility: hidden` still occupies layout space.

### 2.2 Layout, Painting, and Compositing

- **Layout (layout/reflow)** calculates the position and size of each box.
- **Paint** draws text, backgrounds, borders, shadows, etc., onto layers.
- **Composite** merges multiple layers in order into screen pixels.

Changing width, height, font, position, or content often triggers layout; changing color or background usually only requires repaint; modifying `transform` and `opacity` may only require compositing, but it still depends on the browser and whether the element forms an independent layer.

Frequently reading layout properties and then writing styles can cause **layout thrashing**:

```js
// Reading offsetHeight on each loop may forcibly synchronize the layout
for (const item of items) {
  item.style.width = `${container.offsetWidth / 2}px`;
}
```

A more reliable approach is to read first and write later, or merge multiple modifications into a single rendering.

### 2.3 Script Loading

Normal `<script>` scripts block HTML parsing because the script may modify the document. `defer` lets scripts execute in order after the document parsing is complete; `async` lets scripts execute as soon as they finish downloading, but does not guarantee the order.

```html
<script src="app.js" defer></script>
<script src="analytics.js" async></script>
```

Stylesheets can also block rendering, because browsers do not want to render unstyled content first and then suddenly reflow. Critical CSS should be delivered as quickly as possible, and non-critical scripts should avoid blocking the first screen.

## 3. HTML: Express Structure First, Then Style

The core of HTML is not 'div layout,' but semantics and document structure. The correct elements provide default behaviors, keyboard operations, and assistive technology recognition.

| Element | Suitable For |
| --- | --- |
| `header`, `nav`, `main`, `footer` | Page sections |
| `h1`–`h6` | Heading levels |
| `p`, `ul`, `ol` | Paragraphs and lists |
| `button` | Clickable actions |
| `a` | Navigating to another address |
| `form`, `label`, `input` | Form inputs and associations |
| `table` | Row and column data, not for full-page layout |
| `img` of `alt` | Image alternative text |

Buttons and links cannot be replaced simply by `div` with a click event. Native buttons come with keyboard focus, space/enter activation, and disabled states; links handle navigation. Semantic errors will prevent keyboard users and screen readers from using them properly.

### 3.1 Forms and Input Boundaries

```html
<form>
  <label for="email">Email mailbox</label>
  <input id="email" name="email" type="email" required />
  <button type="submit">Save</button>
</form>
```

Browsers can perform basic format validation, but the server must still verify. `required`, `min`, `max` and `pattern` are for user experience and the first line of checking, not a security boundary.

## 4. CSS: Cascade, Box Model, and Layout

CSS rules consist of selectors, properties, and values. When multiple rules apply to the same element, the browser determines the result based on origin, importance, cascade layer, selector specificity, and order of writing.

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

### 4.1 Box Model

Each element can be seen as a box, consisting of content, padding, border, and margin. By default `box-sizing: content-box`, setting `width` only controls the content width; after setting `box-sizing: border-box`, the width includes padding and border.

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
```

The actual width, available space, and scrollbars all affect layout. When debugging, looking at the box model calculated by the browser is more reliable than just viewing the source code.

### 4.2 Normal Flow, Positioning, and Stacking

- `display: block` elements usually occupy a single line; `inline` elements are arranged according to the text flow.
- `position: static` is normal flow; `relative` offsets relative to itself; `absolute` offsets relative to the nearest positioned ancestor; `fixed` offsets relative to the viewport; `sticky` participates in scrolling within thresholds.
- `z-index` is only compared within the same stacking context. Once the parent element creates a new stacking context, the `z-index` of child elements cannot override other elements arbitrarily across contexts.
- `overflow` determines whether content overflowing the box is clipped or scrollable.

Positioned elements are often used for floating layers, dropdown menus, and tooltips, but they are removed from normal flow, which may obscure content, affect keyboard focus, and impact mobile scrolling. Layouts that can be achieved with flex/grid do not need to prioritize using absolute positioning.

### 4.3 Flexbox and Grid

Flexbox is suitable for one-dimensional arrangements: how items in a row or column distribute space, align, and wrap.

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

`min-width: 0` Commonly used to allow flex items to actually shrink, otherwise the content may overflow the container.

Grid is suitable for two-dimensional layouts: it controls both rows and columns at the same time.

```css
.layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 24px;
}
```

`minmax(0, 1fr)` can prevent content from stretching grid columns too wide. Responsive layouts typically combine media queries, relative units, and `clamp()`, rather than writing a completely separate page for each device.

### 4.4 Inheritance, Variables, and Cascading

Some properties are inherited from the parent element, such as fonts and colors; the box model, positioning, and others usually are not. CSS custom properties can define theme variables:

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

Variable values still follow the cascading rules. When the component library overrides styles, first confirm whether it is caused by selector specificity, loading order, or stacking context, and do not blindly add `!important`.

## 5. JavaScript Runtime

The JavaScript language specification defines syntax, types, and semantics; the browser provides host APIs such as DOM, fetch, timers, and storage. Node.js also runs JavaScript, but the host APIs are different, with no DOM, providing file, process, and network service interfaces.

### 5.1 Values, Scope, and Closure

JavaScript's basic types include `string`, `number`, `bigint`, `boolean`, `undefined`, `symbol`, and `null`; objects and arrays are reference types. Assigning an object copies the reference, not a deep copy.

`let` and `const` have block scope, `var` has function scope and involves variable hoisting. After understanding scope, a closure is simply a function that remembers the scope in which it was defined:

```js
function createCounter() {
  let count = 0;
  return () => ++count;
}

const next = createCounter();
next(); // 1
next(); // 2
```

Closures are often used to encapsulate state and callbacks, but they can also prevent large objects that are no longer needed from being garbage collected. Memory issues need to be analyzed in conjunction with actual reference relationships.

### 5.2 this, Prototype, and Classes

`this` depends on how the function is called: normal call, object method call, explicit `call/apply/bind`, constructor, and arrow functions each have their own rules. Arrow functions do not have their own `this`; they capture the outer scope.

JavaScript objects look up properties and methods through the prototype chain. `class` syntax provides a more familiar way to organize code, but underneath it still involves prototypes. Deep inheritance hierarchies can make behavior hard to track; composition and clear boundaries are usually easier to maintain than "inherit everything."

### 5.3 Event Loop

The JavaScript main thread executes only one piece of synchronous code at a time. Asynchronous tasks enter the task queue or microtask queue, and after the current call stack is cleared, the event loop coordinates the execution order.

```js
console.log("A");
setTimeout(() => console.log("B"), 0);
Promise.resolve().then(() => console.log("C"));
console.log("D");
// A D C B
```

`setTimeout(0)` It is not executed immediately, but at least scheduled for later tasks; Promise callbacks are considered microtasks and are usually executed after the current task ends, before the next rendering or timer tasks. A large number of microtasks can still block the page.

`async/await` Makes Promise behave more like synchronous code, but it does not make CPU computation parallel. A long loop will still block the main thread; large tasks need to be split up, delegated to Web Workers, or moved to the server.

### 5.4 Promise and Errors

```js
async function loadUser(id) {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
```

`fetch` Exceptions are only thrown on network layer failures or certain CORS situations; HTTP 404/500 will not automatically reject and must be checked `response.ok`. Asynchronous errors require `try/catch` or to be caught by a unified error boundary.

### 5.5 DOM and Events

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

Events usually bubble from the target element to the ancestors, and can also be handled in the capturing phase. When many child elements need to share a single handler, it can be listened to at the parent level, and the source can be determined through `event.target` or `closest()`; this is called event delegation.

Removing event listeners, canceling timers, and aborting requests are all important. In single-page applications, repeatedly mounting components without cleaning up can lead to duplicate callbacks, increased memory usage, and inexplicable behaviors.

## 6. TypeScript: Compile-time constraints, not runtime guarantees

TypeScript adds static type checking on top of JavaScript. It helps catch misspelled field names, mismatched parameters, unhandled null values, and partial refactoring omissions, but types are essentially erased after compilation.

```ts
type OrderStatus = "pending" | "paid" | "cancelled";

interface Order {
  id: string;
  status: OrderStatus;
  totalCents: number;
}
```

Common Abilities:

- **Type Inference**: Automatically deduce types based on assignments and return values.
- **Union Types and Narrowing**: `string | undefined` narrows the range after null checks.
- **Generics**: Allow functions and data structures to be reused while retaining type relationships.
- **Structural Types**: As long as the object shape satisfies the interface, it can be accepted.
- **`unknown`**: Represents unknown input, must be checked before use; safer than `any`.

```ts
function formatTotal(order: Order): string {
  return `¥${(order.totalCents / 100).toFixed(2)}`;
}
```

Do not use `as` to force assertions to bypass all checks. Data coming from `fetch`, forms, message queues, or local storage is still unknown and should be validated with a runtime schema:

```ts
const data: unknown = await response.json();
if (!isOrder(data)) throw new Error("invalid order");
```

`strict` in TypeScript configuration can catch more issues, but it will expose many errors in old code; enabling it gradually is more reliable than turning off checks altogether.

## 7. Browser Storage and Cache

| Method | Capacity and Lifespan | Suitable for |
| --- | --- | --- |
| Cookie | Small, sent with requests, can set expiration | Session identification, limited state |
| localStorage | Large, persistent, synchronous API | Small amount of non-sensitive preferences |
| sessionStorage | Tab-level session | Temporary form or page state |
| IndexedDB | Large, asynchronous, structured data | Offline data, a large number of client records |
| Cache Storage / Service Worker | Controlled by caching strategy | Resource caching, offline experience |

The `HttpOnly`, `Secure`, and `SameSite` of a cookie affect security and cross-site behavior. `localStorage` can be easily read by scripts and should not store long-term tokens or sensitive personal information. Browser storage is not a server-side database; capacity, cleanup policies, and multi-device consistency are all unreliable.

HTTP caching is controlled by headers such as `Cache-Control`, `ETag`, and `Last-Modified`. Static resources can use filenames with content hashes and long caching; HTML usually requires more careful caching strategies to avoid users seeing outdated entries for a long time.

## 8. Graphics and Animation

- **CSS animations** are suitable for simple movements, opacity, and color changes, and can take advantage of browser compositing.
- **SVG** is suitable for icons, charts, and scalable vector graphics, and is DOM-interactive.
- **Canvas** is suitable for large-scale pixel rendering, games, and real-time visualization, but the content is not naturally accessible as DOM.
- **WebGL / WebGPU** are suitable for high-performance 2D/3D rendering, with higher complexity and compatibility.

The key to animation performance is not 'which API is used,' but how much work is done each frame. Prioritize animating `transform` and `opacity`, avoid reading and writing layout each frame; use `requestAnimationFrame` to sync with the browser's refresh rhythm. For users who need to reduce dynamic effects, `prefers-reduced-motion` should be respected.

## 9. Front-end Requests and Security Boundaries

Requests in the browser are restricted by the same-origin policy. Any difference in protocol, domain, or port counts as cross-origin. CORS is a mechanism that allows the server to permit the browser to read cross-origin responses; it is not access control itself; the server still must verify identity and permissions.

Concepts that need to be distinguished:

- Cross-origin requests can be sent, but the browser may block the script from reading the response.
- CORS preflight (OPTIONS) handles the permission negotiation for non-simple requests.
- CSRF exploits the browser's automatic cookie-carrying behavior, and protection often relies on SameSite, CSRF tokens, and the correct request methods.
- XSS allows attackers to execute scripts on a page, and the risk should be mitigated through output encoding, trusted templates, and content security policies.
- Hiding buttons on the front end does not equal authorization; all sensitive operations must be re-checked on the server side.

## 10. How to Layer Page Issues

| Phenomenon | Priority Check |
| --- | --- |
| White screen | Whether HTML is returned, whether the script reports errors, whether resources are 404 |
| Style Issues | Whether CSS is loaded, whether selectors are hitting, box model and stacking |
| Click has no response | Check if the event is bound, if the element is covered, or if the script is interrupted |
| Data not updated | Whether the request was successful, whether the status was updated, whether the component re-rendered |
| Slow First Screen | Resource Size, Blocking Scripts, Critical CSS, Images and Fonts |
| Scroll Jank | Long main thread tasks, layout thrashing, too many DOM elements or painting |
| State lost after refresh | Memory state not persisted, storage strategy, or cache issue |
| Cross-domain Failure | CORS, Cookie, SameSite, Preflight, and Proxy Configuration |

## Checklist

- Whether HTML expresses the correct semantics, rather than just stacking `div`.
- Whether the page can be used at different widths and with keyboard operations.
- Whether CSS layout understands normal flow, the box model, and stacking context.
- Whether JavaScript correctly handles asynchronous errors, cancellation, and cleanup.
- Whether to distinguish between synchronous code, microtasks, macrotasks, and true parallel computation.
- Whether TypeScript types cover boundaries, and whether runtime inputs are still validated.
- Whether the browser storage only saves appropriate data and whether sensitive information is handled correctly.
- Whether static resources and HTML use matching caching strategies.
- Whether network requests consider cross-origin, authentication, timeout, and cancellation.
- Should performance issues be first identified using the Performance panel, rather than blindly reducing code.
