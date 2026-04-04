# Behavior Extraction Flow

## Purpose

This document explains, in maintainers' terms, how Codeflow Analyzer turns static React / Next.js source code into behavior summaries and flow data without executing the app.

The key question this document answers is:

How can we read frontend code and deterministically infer what a user can do, what that interaction triggers, and what parts of the UI or route tree it affects?

The short answer is:

`frontend source -> structural signals -> linked effects -> ranked behaviors -> reports`

The long answer is the rest of this document.

## Terminology

This document uses the following terms consistently:

- `signal`
  - a raw statically extracted fact such as a route, state, event, API call, navigation action, or conditional

- `flow`
  - a connected interaction path through signals, usually starting from an event and continuing through state, API, navigation, or conditional relationships

- `behavior`
  - a synthesized human-readable user action summary built from one or more signals

- `feature group`
  - the feature-area bucket used to organize behaviors in reports, such as `Authentication`, `Sessions`, `Applications`, or `Settings`

## Core Principle

The analyzer is intentionally static and deterministic.

That means:
- it does not run the frontend
- it does not call a browser
- it does not click the UI
- it does not ask an LLM to guess missing meaning
- it does not rely on screenshots, DOM snapshots, or runtime traces

Instead, it only reads:
- source files
- imports
- JSX structure
- AST nodes
- function bodies
- symbol references
- string literals and expressions that are statically visible

This makes the tool:
- reproducible
- explainable
- stable across runs
- suitable for CI and large codebases

It also means we only claim behavior when the code gives us enough evidence to support it.

## What "Behavior" Means In This Project

A behavior is not just "there is an event handler".

A behavior is our synthesized view of:
- the user trigger
- the important internal side effects
- the likely user-visible outcome

Example:

Source code:

```jsx
<form onSubmit={handleLogin}>
```

```js
async function handleLogin(e) {
  e.preventDefault();
  setLoading(true);
  await login(email, password);
  navigate('/dashboard');
}
```

Static interpretation:
- trigger: user submits login form
- internal steps: updates loading state, calls auth action / API, navigates
- outcome: route changes to dashboard

Rendered behavior:
- `User can log in`

This `behavior` is a synthesized artifact built on top of lower-level `signals`.

## The Two Kinds Of Truth We Extract

The analyzer mainly extracts two kinds of truth.

### 1. Structural truth

These are facts directly visible in the code:
- a file declares `useState`
- a JSX element has `onClick`
- a function calls `fetch(...)`
- a component renders under `/sessions/:reservationId`
- a branch is guarded by `isActive && ...`

This layer is objective and local.

### 2. Behavioral truth

These are inferred from multiple structural facts combined together:
- clicking "Release" releases the current session
- changing "Search applications..." filters application results
- submitting login navigates to dashboard on success
- opening a panel exposes tools related to the current session

This layer is still deterministic, but it is synthesized from linked signals rather than read directly from one line of code.

## External Tools Used

### `@ast-grep/napi`

Used for the first-pass structural scan.

Why we use it:
- it is fast across large repos
- it lets us cheaply narrow the candidate file set
- it prevents us from doing expensive deep AST work on every file equally

What it pre-identifies:
- `useState`, `useReducer`
- `fetch(...)`
- `axios.*(...)`
- custom API-like calls
- JSX event attributes such as `onClick`, `onSubmit`, `onChange`
- `navigate(...)`, `router.push(...)`, `Link href=...`
- route declarations

Important note:
- `ast-grep` does not decide the final behavior
- it only helps us decide where to spend deeper analysis effort

### `ts-morph`

Used for the deep extraction stage.

Why we use it:
- it gives a real AST over JS / JSX / TS / TSX
- it understands JSX nodes well enough for React analysis
- it supports symbol-aware queries such as definitions and references
- it lets us inspect function bodies, imports, object returns, and nested JSX

What it extracts:
- routes
- state declarations
- state writes and reads
- derived state
- event handlers
- navigation actions
- API calls
- conditionals
- shared actions exposed by hooks / context

Important note:
- `ts-morph` is where most of the actual understanding happens
- `ast-grep` is mainly a targeting layer

### `graphlib`

Used after extraction to connect isolated signals into flows.

Why we use it:
- it gives a uniform directed graph model
- it lets us represent routes, events, state, API calls, navigation, and conditionals as one connected structure
- it makes flow enumeration much easier than ad hoc nested loops

Important note:
- `graphlib` does not invent meaning
- it only gives us a compact way to connect already extracted facts

## The Real Mental Model

The implementation follows this pipeline:

`Code -> Candidate Files -> Signals -> Relationships -> Graph -> Behaviors -> Reports`

Each stage narrows ambiguity and adds structure.

## Stage 1: Candidate Discovery

Implemented mainly in:
- [src/prescan.js](/Users/himanshukukreja/static-code-analyzer/src/prescan.js)

Goal:
- quickly find which files are likely to contain important behavior signals

Why this stage exists:
- large frontend repos often contain hundreds of files
- many are styling, constants, layout wrappers, or helper utilities
- most do not need the same deep analysis budget

What this stage produces:
- sets of candidate files for:
  - events
  - state
  - API calls
  - navigation
  - routes

Why this is deterministic:
- the patterns are fixed
- the scan reads only source text
- the same repo always produces the same candidate sets

## Stage 2: Project Loading And File Context

Implemented mainly in:
- [src/project.js](/Users/himanshukukreja/static-code-analyzer/src/project.js)

Goal:
- build a consistent AST-level project context across all relevant source files

What this stage handles:
- file discovery
- JS / JSX / TS / TSX loading
- framework detection
- fallback loading even when `tsconfig.json` is too restrictive

Why this stage matters:
- if the project loader misses important files, every later inference becomes incomplete
- route mapping and cross-file symbol tracing only work when the source files are actually in the project

This stage is one reason the tool performs much better on real repos than simple regex-only scripts.

## Stage 3: Structural Extraction

Implemented mainly in:
- [src/extract.js](/Users/himanshukukreja/static-code-analyzer/src/extract.js)

This is the main signal extraction phase.

It produces the raw signal sets that everything else depends on.

### 3.1 Route extraction

The extractor looks for routes from:
- Next.js `app/` files
- Next.js `pages/` files
- React Router `<Route path=... element=... />`

It also tries to recover route ownership for wrapped route trees such as:

```jsx
<Route
  path="/sessions/:reservationId"
  element={
    <ProtectedRoute>
      <AppShell>
        <SessionView />
      </AppShell>
    </ProtectedRoute>
  }
/>
```

That matters because otherwise `SessionView.jsx` would look route-less even though it clearly belongs to `/sessions/:reservationId`.

What this gives us:
- route path
- route source file
- component identity
- dynamic params
- route lookup maps for later stages

### 3.2 Function extraction

The extractor builds a per-file function registry so that JSX handler references can be resolved.

It supports:
- named function declarations
- function expressions
- arrow functions
- functions wrapped in `useCallback(...)`
- functions wrapped in similar helper calls we explicitly support

Why this matters:
- many production apps do not attach inline handlers directly
- they do `onClick={handleRelease}` or `const release = useCallback(...)`
- if we cannot recover the real body, we cannot recover the real effects

### 3.3 State extraction

The extractor finds state declarations such as:
- `useState`
- `useReducer`

For each state it records:
- state name
- setter name
- initial value
- route
- scope
- read sites
- write sites

This is one of the foundations for understanding UI behavior.

Example:

```js
const [statusFilter, setStatusFilter] = useState('');
```

Later, when we see:

```jsx
onClick={() => setStatusFilter(tab.value)}
```

we can deterministically say:
- the event mutates `statusFilter`
- the UI can re-render from that mutation

### 3.4 Derived state extraction

The extractor looks for derived values computed from state, for example:
- `useMemo(...)`
- state-dependent expressions

This helps us understand chains like:

`input -> state -> derived collection -> rendered list`

Without derived state tracking, we can still see that input changes state.
With derived state tracking, we can also explain how that state influences displayed results.

### 3.5 Navigation extraction

The extractor detects navigation from:
- `Link href=...`
- `navigate(...)`
- `router.push(...)`
- `router.replace(...)`

For each navigation signal we record:
- target
- source file
- line
- source route
- mechanism

This is what lets us say:
- "submit login -> navigate to dashboard"
- "release session -> navigate back to devices"

### 3.6 API extraction

The extractor detects API interactions from:
- `fetch(...)`
- `axios.get/post/...`
- custom axios-style clients such as `client.get(...)`
- `.request({ url, method })`
- imported helper functions in `src/api/*`

That last part matters a lot for real repos.

Most mature frontends do not put network calls directly inside page components.
They often do this instead:

```js
import { releaseSession } from '../api/sessions';
```

```js
await releaseSession(reservationId);
```

and inside `src/api/sessions.js`:

```js
client.post(`/api/v1/sessions/${reservationId}/release`);
```

The analyzer now follows this one hop so the behavior can still recover:
- the event calls a shared action or helper
- that helper performs a `POST /api/v1/sessions/:param/release`

This is still deterministic because:
- we only follow statically resolvable imports
- we only inspect imported source code we can read
- we do not speculate across unknown runtime dispatch

### 3.7 Conditional extraction

The extractor records conditional rendering from:
- ternaries
- `&&` JSX guards
- surrounding `if` conditions that gate event visibility

This helps us say things like:
- "available when `isActive`"
- "guarded by `showDeleteModal`"
- "this interaction only appears when the current panel is open"

Conditionals are important because not every event is always available to the user.

### 3.8 Event extraction

This is the main bridge between UI and behavior.

The extractor walks JSX attributes like:
- `onClick`
- `onSubmit`
- `onChange`
- custom event props when they appear in JSX

For each event signal it records:
- event name
- element tag / component
- source file
- route
- UI text or label candidates
- guard condition
- resolved handler
- triggered effects

This gives us the raw material for "user can click X" or "user can submit Y".

## Stage 4: Shared Action Recovery

Not all meaningful work happens directly inside page handlers.

Modern React code often hides logic in:
- custom hooks
- context providers
- returned action objects

Example shape:

```js
const { release } = useSessions();
```

```js
onClick={handleRelease}
```

```js
await release(reservationId);
```

To recover meaning here, the analyzer:
- inspects objects returned from hooks
- inspects values passed into context providers
- binds destructured hook/context actions back to local names

That lets us turn:
- local call `release(...)`

into:
- shared action `useSessions.release`

and then later into:
- state writes
- API calls
- navigation

when those can be statically recovered.

## Stage 5: Imported Helper Recovery

This stage is related to shared action recovery, but different.

Shared action recovery handles:
- hook/context methods exposed to components

Imported helper recovery handles:
- imported functions from helper modules, especially `src/api/*`

Example:

```js
import { triggerInstall } from '../api/installs';
```

```js
await triggerInstall(reservationId, app.id);
```

and then in `src/api/installs.js`:

```js
client.post('/api/v1/installs', ...)
```

The analyzer follows this one-hop relationship when possible.

This improves behavior quality in real apps because it connects:
- UI event
- helper function
- real endpoint

without runtime execution.

This is intentionally shallow.

We do not currently try to perform arbitrary whole-program interprocedural expansion because:
- complexity rises quickly
- determinism becomes harder to explain
- false confidence becomes more dangerous

## Stage 6: Side-Effect Recovery

Once we know an event and its handler body, we recover the important side effects.

For each event handler we look for:
- state mutations
- API calls
- navigation
- shared action calls
- browser APIs like `window.confirm`

This is where the analyzer moves from:
- "this button has `onClick`"

to:
- "clicking this button updates state, calls an API, and navigates"

This is the key step that makes the final output behavior-oriented rather than JSX-oriented.

## Stage 7: Graph Construction

Implemented mainly in:
- [src/graph.js](/Users/himanshukukreja/static-code-analyzer/src/graph.js)

At this point we have many isolated signals.

Examples:
- one route
- one event
- one state
- one API call
- one conditional

The graph stage connects them into a shared model.

### Node kinds

The graph currently models nodes such as:
- route
- event
- state
- derived state
- API
- navigation
- conditional

### Edge kinds

Edges encode relationships such as:
- `contains`
- `writes`
- `calls`
- `navigates`
- `targets`
- `derives`
- `controls`

Example:

`/login -> submit event -> POST /api/auth/login -> navigate /dashboard`

This is much easier to represent and traverse in a graph than in isolated lists.

## Stage 8: Flow Enumeration

Implemented mainly in:
- [src/graph.js](/Users/himanshukukreja/static-code-analyzer/src/graph.js)

The graph is traversed to enumerate candidate flows.

Examples:
- route -> form submit -> API -> navigation
- route -> input change -> state -> derived state
- route -> click -> state mutation -> conditional UI

These are not yet final human-facing behaviors.
They are candidate execution-like paths inferred from the static structure.

This matters because behaviors often need both:
- a concise title
- a more detailed flow or data-flow explanation

## Stage 9: Behavior Synthesis

Implemented mainly in:
- [src/summarize.js](/Users/himanshukukreja/static-code-analyzer/src/summarize.js)

This stage turns raw extracted events into higher-level behavior descriptions.

This is where most of the readability comes from.

### 9.1 Why synthesis exists

If we exposed every event directly, large repos would be unreadable.

For example, raw events might include:
- punctuation-only button text
- wrapper component callbacks
- modal close handlers
- generic `button` / `div` / `input` interactions

Those are structurally real, but often too low-level for a human behavior summary.

### 9.2 Behavior scoring

Each event is ranked using deterministic heuristics such as:
- does it have API effects?
- does it navigate?
- does it mutate state?
- does it call a shared action?
- does it belong to a route?
- does it have a meaningful visible label?
- is it a low-signal event type?

This lets us:
- keep higher-value behaviors
- drop or deprioritize lower-signal noise

### 9.3 Behavior naming

Behavior titles are not random text generation.
They come from deterministic cues such as:
- API endpoint semantics
- route name
- source file name
- handler name
- element text
- label
- placeholder
- test id

Examples:
- endpoint `/api/v1/auth/login` -> `User can log in`
- endpoint `/api/v1/sessions/:param/release` -> `User can release a session`
- input labelled `Search applications...` -> `User can search applications`
- route `/settings` + submit -> `User can submit the settings form`

This is a rules-based mapping layer, not an LLM summary.

### 9.4 Feature groups

The synthesizer groups behaviors into feature groups using:
- route context
- source file path
- feature aliases

Examples:
- `/sessions/*` -> `Sessions`
- `components/apps/*` -> `Applications`
- `/login` or auth endpoints -> `Authentication`

This is why large repos become readable as:
- Sessions
- Applications
- Devices
- Installs
- Authentication

instead of one flat list of hundreds of callbacks.

### 9.5 Trigger and outcome phrasing

The synthesizer also normalizes:
- trigger text
- internal steps
- outcomes

Examples:
- `Click Release`
- `Calls POST /api/v1/logs/:param/start`
- `Navigates to /dashboard`
- `UI can update from loading changes`

The phrasing is template-based and derived from extracted effects.

## Stage 10: Report Synthesis

Implemented mainly in:
- [src/output.js](/Users/himanshukukreja/static-code-analyzer/src/output.js)

The final output is written in two forms:

### `behavior.json`

This keeps the structured result:
- routes
- states
- events
- API calls
- navigation
- behaviors
- data flows
- summary

This is the machine-readable artifact.

### `behavior.txt`

This is the human-readable artifact.

It prioritizes:
- project summary
- key routes
- API surface
- feature behaviors
- flow highlights
- data flows

This is the artifact meant for humans trying to understand the app quickly.

## Why This Is Deterministic

This is the most important section.

The tool is deterministic because every conclusion comes from fixed rules over static code.

There is no hidden probabilistic reasoning step.

### Deterministic inputs

We only read:
- local files
- their imports
- their AST
- fixed node relationships

### Deterministic extraction rules

Examples:
- `onClick={handleRelease}` means a JSX event exists
- `setLoading(true)` means loading state is written
- `navigate('/dashboard')` means navigation to `/dashboard`
- `client.post('/api/v1/sessions/reserve')` means a POST call to that endpoint
- `showDeleteModal && <ConfirmModal />` means conditional UI gated by `showDeleteModal`

### Deterministic synthesis rules

Examples:
- auth login endpoint maps to `User can log in`
- search-like labels map to `User can search ...`
- delete-like endpoints map to `User can delete ...`
- low-signal events are scored lower than route-level API-backed actions

### Deterministic ranking

When two behaviors compete for attention, the ordering is based on stable signals:
- priority score
- confidence
- lexical fallback ordering

So the same codebase should produce the same report every time.

## What The Tool Does Not Do

To understand the boundaries, it is useful to be explicit.

The tool does not:
- execute runtime conditions
- know real API responses
- know server-side business logic
- know CSS visibility beyond code-expressed conditions
- know dynamically generated routes that are invisible to static inspection
- fully evaluate arbitrary JavaScript expressions
- fully trace every imported function through unlimited call depth

So when we say "proper behaviors", we mean:
- behaviors that can be justified from frontend source evidence alone

not:
- perfect runtime truth in every possible application architecture

## Why This Still Works Well In Practice

Even without execution, modern frontend code usually reveals a lot:
- the route tree
- the user entry points
- the form controls
- the handler wiring
- the state updates
- the network endpoints
- the navigation targets
- the visible guards

That is enough to recover a large portion of meaningful product behavior in a deterministic way.

For many repos, especially React apps with clear hooks and API modules, this is sufficient to answer:
- what can the user do?
- what happens when they do it?
- what data or route changes follow?

## Practical Example

Consider a session page that contains:
- a `Release` button
- a `Logs` button
- a screenshot action
- a recording action

The analyzer can statically recover:
- these are clickable user actions
- some are only visible when `isActive`
- one action triggers a release flow through a shared hook action
- another starts logs via a `POST /api/v1/logs/:param/start`
- others update state or open panels

From that, the report can say:
- `User can release a session`
- `User can start device logs`
- `User can take a screenshot`
- `User can start a recording`

That is not guesswork.
It is deterministic synthesis over statically extracted evidence.

## Mental Model For Maintainers

When maintaining the analyzer, the safest way to think about it is:

1. Extract only what the code clearly tells us
2. Preserve the link between trigger and effect
3. Prefer deterministic rules over clever guessing
4. Keep synthesis explainable
5. Drop low-signal output before it reaches the final report

If a behavior cannot be explained from source evidence, we should not pretend we know it.

That is the core design philosophy of Codeflow Analyzer.
