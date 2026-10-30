# Changelog

## 0.1.0 (2026-10-30)


### Features

* **agents:** add the shared agent sources, the generator with local sources and includes, and publish-review ([#36](https://github.com/agenticool/agenticool/issues/36)) ([28de2ba](https://github.com/agenticool/agenticool/commit/28de2ba9b16ce702066b25337750195dcd8273e5))
* **agents:** make the monorepo consume its own agents, tracker files, and workflow lint ([#45](https://github.com/agenticool/agenticool/issues/45)) ([00870e0](https://github.com/agenticool/agenticool/commit/00870e084bf78bd7b953c7d7916bb0c747a8445a))
* **agents:** move the workflow naming, Status, and dependency rules agents need into synced files ([#44](https://github.com/agenticool/agenticool/issues/44)) ([dcbb8ba](https://github.com/agenticool/agenticool/commit/dcbb8ba1922d7eaf61c26cde1ee16b48f1ac5306))
* **agents:** read infrastructure account-check paths from the binding ([#50](https://github.com/agenticool/agenticool/issues/50)) ([1e64eef](https://github.com/agenticool/agenticool/commit/1e64eefd734cfe87627351616df934e3e6303da3))
* **agents:** run the spec commands from the spec-to-issues skill ([#43](https://github.com/agenticool/agenticool/issues/43)) ([c1483b3](https://github.com/agenticool/agenticool/commit/c1483b39359876c2e2baf4607a1055518adc5e22))
* **agents:** stop delivery when another worktree has the target branch checked out ([#38](https://github.com/agenticool/agenticool/issues/38)) ([e6dfac9](https://github.com/agenticool/agenticool/commit/e6dfac9348b4bfd831e89b60ff62573f929f5ca1))
* **agents:** sync tracker files, shared AGENTS.md sections, the agent .gitignore block, and browser MCP config ([#42](https://github.com/agenticool/agenticool/issues/42)) ([30fca27](https://github.com/agenticool/agenticool/commit/30fca27023240368b96036e2b6c598ea7a4f5c26))
* **delivery:** pair ready leaves of different phase epics from a plan-wide independence record ([#46](https://github.com/agenticool/agenticool/issues/46)) ([0f93082](https://github.com/agenticool/agenticool/commit/0f9308278d2be637fdc0e7db1b791bdb15388448))
* **repository:** scaffold the monorepo and release pipeline ([#28](https://github.com/agenticool/agenticool/issues/28)) ([db32c1e](https://github.com/agenticool/agenticool/commit/db32c1e551d00122b9a823b3f3a475c1cd2e0cf7))
* **tracker:** install only the tracker package in the reusable tracker workflows ([#54](https://github.com/agenticool/agenticool/issues/54)) ([782a63f](https://github.com/agenticool/agenticool/commit/782a63fdc54747e7041c98426defd8ad0ffa8118))


### Bug Fixes

* **agents:** point the agents skill at consumer paths ([#48](https://github.com/agenticool/agenticool/issues/48)) ([3738a1a](https://github.com/agenticool/agenticool/commit/3738a1a0ae7ce33023feb7de80b54b3152ca03bb))
* **agents:** prefix shared skills and agents with ac- and rename the agents skill to agent-config ([#62](https://github.com/agenticool/agenticool/issues/62)) ([0ea3b35](https://github.com/agenticool/agenticool/commit/0ea3b352bc59fee115cf57a807ffa452329db210))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @agenticool/board bumped from ^0.0.0 to ^0.1.0
    * @agenticool/core bumped from ^0.0.0 to ^0.1.0
