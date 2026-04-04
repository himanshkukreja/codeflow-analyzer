# Codeflow Analyzer

`codeflow-analyzer` is a Node.js CLI that statically analyzes a React or Next.js codebase and generates behavior reports without running the app.

It extracts raw analysis signals such as:
- routes
- user-triggered events
- state updates
- API calls
- navigation
- conditional rendering
- then turns those signals into behaviors, data flows, and interaction flows

The tool is designed for frontend teams who want a fast structural understanding of a codebase:

- What can a user do?
- What happens after each action?
- Which routes, APIs, and states are involved?
- Which flows are possible from the code alone?

## Terminology

The tool uses a few terms in a very specific way:

- `signal`
  - a raw statically extracted fact from the codebase, such as a route, event, state, API call, navigation action, or conditional

- `flow`
  - a connected path through extracted signals, usually starting from an event and continuing through state changes, API calls, navigation, or conditional UI

- `behavior`
  - a human-readable summary of a likely user action, built from one or more signals and flows

- `feature group`
  - the feature-area bucket used to organize behaviors in reports, such as `Authentication`, `Sessions`, `Applications`, or `Settings`

## Install

Global install:

```bash
npm install -g codeflow-analyzer
```

Run with `npx`:

```bash
npx codeflow-analyzer /path/to/project
```

Run from source:

```bash
npm install
npm run analyze -- /path/to/project
```

## Usage

Basic usage:

```bash
codeflow-analyzer <path-to-project-or-zip>
```

Write outputs to a custom directory:

```bash
codeflow-analyzer <path-to-project-or-zip> --output ./reports
```

Examples:

```bash
codeflow-analyzer ./demo-app
codeflow-analyzer ./demo-app --output ./analysis-output
npx codeflow-analyzer ./demo-app
```

## Output Files

The CLI writes two files named from the analyzed project:

- `<project-name>-behavior.txt`
- `<project-name>-behavior.json`

By default, the files are written to the directory where you run the command.

If you pass `--output`, they are written to that directory instead.

Example:

```bash
codeflow-analyzer ./demo-app
```

If you run that inside `/Users/himanshukukreja/tools`, the output will be:

```bash
/Users/himanshukukreja/tools/demo-app-behavior.txt
/Users/himanshukukreja/tools/demo-app-behavior.json
```

## Understanding The Output

### Text report

`<project-name>-behavior.txt` is the human-readable summary.

It currently contains:

- `Project Summary`
  - project name
  - framework
  - input path
  - output path
  - counts for routes, states, APIs, events, behaviors, flows

- `Key Routes`
  - the main detected routes and mapped components

- `API Surface`
  - unique detected API endpoints

- `Feature Behaviors`
  - grouped behavior summaries by feature group such as Authentication, Users, Settings, Sessions, Applications
  - each behavior includes:
    - trigger
    - internal steps
    - outcome
    - route
    - confidence

- `Flow Highlights`
  - interaction flows inferred by connecting signals such as events, state changes, API calls, navigation, and conditions

- `Data Flows`
  - simplified data-movement summaries built from signals such as:
    - input -> state -> derived UI
    - button click -> API -> state update -> navigation

### JSON report

`<project-name>-behavior.json` is the machine-readable output.

Top-level fields include:

- `summary`
- `routes`
- `states`
- `derivedState`
- `events`
- `apiCalls`
- `navigation`
- `conditionals`
- `behaviors`
- `dataFlows`
- `flows`

Useful sections:

- `summary`
  - quick counts
  - route overview
  - API surface
  - grouped feature-group summaries

- `behaviors`
  - the main “what can the user do?” list
  - each item is a synthesized user-facing behavior, not just a raw event

- `dataFlows`
  - good for understanding how data moves through the UI

- `flows`
  - good for understanding interaction sequences built from connected signals

## What The Tool Detects

The analyzer currently focuses on deterministic static extraction.

It can detect:

- React Router and Next.js routes
- JSX event handlers like `onClick`, `onSubmit`, `onChange`
- common custom component handler props like `onPress` when present in JSX
- `useState` and `useReducer`
- `useMemo`-style derived state
- `fetch` and `axios` calls
- `Link`, `navigate`, `router.push`, `router.replace`
- JSX conditional rendering
- context/provider exposed actions
- returned actions from custom hooks

## How It Works

The CLI uses a two-stage analysis pipeline:

1. `@ast-grep/napi`
   - fast structural pre-scan
   - identifies candidate files for routes, state, events, APIs, and navigation

2. `ts-morph`
   - deep AST traversal and symbol-aware extraction
   - extracts routes, states, handlers, actions, and side effects

Then it uses:

- `graphlib`
  - to construct a graph from extracted signals
  - to enumerate interaction flows from those connected signals

## Limitations

This is a static analyzer, so it intentionally does not execute the app.

Current limitations:

- output quality depends on how explicit the source code is
- very large repos can produce noisy behavior/event counts
- custom component abstractions may need deeper prop-resolution to become fully human-readable
- some flows are still structurally correct but not yet phrased in the best business language
- Redux, React Query, and SWR modeling are not fully implemented yet

## Good Use Cases

- onboarding into a large frontend repo
- auditing routes and API surface
- understanding state-driven behaviors
- generating internal documentation
- discovering candidate user journeys for testing

## Typical Use Cases

### 1. Frontend Onboarding

When a new engineer joins a project, they can run the CLI on the frontend repo and quickly get:

- the main routes
- major feature groups
- important user behaviors
- interaction flows already present in the code

This is useful when the codebase is large and documentation is incomplete.

### 2. QA And Test Planning

QA engineers can use the generated reports to discover:

- which user actions are available
- what APIs each action touches
- which flows are likely worth end-to-end coverage
- where state and conditionals may create edge cases

This is especially helpful before writing manual test plans or Playwright tests.

### 3. Product And Feature Understanding

Product managers, engineering managers, or tech leads can use the text report to understand:

- what the application currently allows users to do
- how features are grouped across routes
- which pages and APIs power each capability

That makes the tool useful for feature audits and release reviews.

### 4. Legacy Codebase Discovery

For older React apps with weak documentation, the CLI helps answer:

- what routes still exist
- which components still trigger backend calls
- which features are driven by state vs navigation
- which interaction paths are still reachable from the code

This is useful before refactoring or cleanup work.

### 5. Architecture And Dependency Audits

The JSON output is useful when you want to inspect:

- route-to-component relationships
- behavior-to-API mappings
- data-flow summaries
- repeated interaction patterns across the app

This can support internal tooling, audits, or dashboards.

### 6. Pre-Migration Analysis

If a team is planning to migrate:

- React Router to Next.js
- legacy state patterns to modern ones
- one UI library to another

the analyzer helps create a before-state snapshot of:

- current behaviors
- current routes
- current flow structure
- major user interaction patterns

### 7. Internal Documentation Generation

The text report can be shared directly with internal teams as a starting point for:

- feature documentation
- QA notes
- architecture reviews
- behavior summaries for stakeholders

### 8. Change Impact Exploration

Before editing a large feature area, developers can inspect the report to understand:

- what user-facing behaviors exist in that area
- which routes and APIs are involved
- which flows may be affected by changes

This is not yet a full impact-analysis engine, but it is already useful for fast exploration.

## Development

Install dependencies:

```bash
npm install
```

Run the CLI locally:

```bash
npm run analyze -- ./demo-app
```

Show help:

```bash
npm run cli:help
```

## Publishing Checklist

Before publishing to npm:

1. Choose the final package name in `package.json`
2. Review the `bin` name exposed to users
3. Verify `npm pack`
4. Test global install locally
5. Update version
6. Publish with `npm publish`
