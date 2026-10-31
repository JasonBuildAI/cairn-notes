---
title: "Source and Copyright"
description: "The content licensing of Cairn Notes, the ownership of upstream projects, the rewriting scope and error correction methods of the four sets of source code courses and engineering fundamentals."
---

## Scope of License

- **Pi, OpenSandbox, and four sets of source code course study notes**: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Sharing and adaptation are allowed, but must be credited and shared in the same manner. 
- **Engineering Fundamentals (`engineering/`)**: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Adapted from EasyVibe, non-commercial sharing and adaptation are allowed, but must be credited and shared in the same manner. 
- **Site Code, Build Scripts, and Configuration**: [MIT](https://github.com/JasonBuildAI/cairn-notes/blob/main/LICENSE). Freely usable, modified, and distributed, with copyright and license notices reserved. 
- **Upstream Project Source Code, Name, and Materials**: Licensed by each party. This site does not reauthorize and does not represent upstream projects. 

If the entire site content is reposted together, both CC licenses must be met; Among them, engineering foundations cannot be used for commercial purposes. Do not label the entire site as a single license. 

## Upstream Project

### Pi

- Learner version: v1.3.0, `71023aec`
- Upstream license: MIT
- Source: <https://github.com/earendil-works/pi>

### OpenSandbox

- Learner version: release-1.1.1, `531700ca`
- Upstream license: Apache-2.0
- Source: <https://github.com/opensandbox-group/OpenSandbox>

### DeerFlow

- Learning version: v2.1.0, `345f08be`
- Upstream license: MIT
- Source: <https://github.com/bytedance/deer-flow>

### LoopX

- Learning version: v2.1.1, `87e5b4f8`
- Upstream license: Apache-2.0
- Source: <https://github.com/loopx-project/loopx>

### OpenClaw

- Learning version: Released and archived on 2026.10.9
- Upstream license: MIT
- Source: <https://github.com/openclaw/openclaw>

### Hermes Agent

- Learning version: v0.22.5 released and archived
- Upstream license: MIT
- Source: <https://github.com/NousResearch/Hermes-Agent>

### EasyVibe

- Verified versions: `main`,`f2239c67` (2026-10-22)
- Upstream license: CC BY-NC-SA 4.0
- Source: <https://github.com/DatawhaleChina/easy-vibe>

EasyVibe's license statement is written in its upstream README. The engineering foundation corresponds to 104 Markdown files from Appendix 1 to 9, but not translated or reprinted individually. Chapter 1 is highly compressed; The remaining chapters are merged, cut, rearranged, and supplemented according to the general software engineering learning path, and rewritten into static tables, ASCII flowcharts, short examples, and checklists. Models, retrieval, and agents are dedicated systems for the last chapter, without establishing a separate engineering methodology. Additionally, a new chapter titled "From Requirements to Stable Operation: An Engineering Panorama" has been added, linking chapters with custom cases, which is a reorganization of this set of notes. 

This site does not copy upstream images, animations, interactive components, or complete course pages. Examples and tables need to be reorganized by Note. If you find issues with attribution or citation boundaries, please contact us via Issue, and I will verify and correct or remove them. 

The relevant full license text is located in the repository's [`LICENSES/`](https://github.com/JasonBuildAI/cairn-notes/tree/main/LICENSES) directory. Cairn Notes has no affiliation or endorsement relationship with the maintainers of the above projects. 

## Citation Methods

When citing Pi, OpenSandbox, or four sets of source code course notes, it is recommended to write: 

> Cairn Notes, Page Title, <https://jasonbuildai.github.io/cairn-notes/>, CC BY-SA 4.0. 

When citing engineering fundamentals, it is recommended to write: 

> Cairn Notes, "Page Title," adapted from EasyVibe by Datawhale / EasyVibe contributors, CC BY-NC-SA 4.0, with modifications. 

## Why didn't I upload the source code?

Public repositories do not include: 

- Complete source code or `.git` directory of the upstream repository; 
- Official release compressed package; 
- Upstream images, animations, and interactive components; 
- Local environment snapshots, private configurations, or credentials. 

If you want to run an experiment, please check the corresponding versions listed above from the official repository. Notations like `$PI_SRC`, `$OSB_SRC`, `$DEERFLOW_SRC`, `$LOOPX_SRC`, `$OPENCLAW_SRC`, `$HERMES_SRC` in notes only indicate the reader's own local directory. 

## Correction and Delisting

If you find factual errors, version drift, missing attribution, or if you believe a passage exceeds reasonable citation boundaries, please contact us via [GitHub Issues](https://github.com/JasonBuildAI/cairn-notes/issues). I will verify first, then correct, supplement, or remove the relevant content. 

This repository only handles Issues and does not accept Pull Requests.
