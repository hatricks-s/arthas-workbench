# Third-party attribution

The MIT license in this repository covers project-authored code and documentation. It does not replace the licenses of dependencies, tools or external runtimes.

## Upstream projects

| Project | Role | Upstream license |
| --- | --- | --- |
| [Alibaba Arthas](https://github.com/alibaba/arthas) | External Java diagnostic runtime and protocol behavior | Apache-2.0 |
| [FastMCP](https://github.com/prefecthq/fastmcp) | Python MCP server/client framework | Apache-2.0 |
| [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) | MCP protocol implementation | MIT |
| [Kubernetes](https://github.com/kubernetes/kubernetes) | External kubectl port forwarding | Apache-2.0 |

These are selected direct upstreams, not an exhaustive dependency license inventory. Refer to `uv.lock`, `requirements.lock`, `connector/Cargo.lock`, and each package's own distribution for the complete dependency set and applicable terms. The repository does not bundle Arthas, a JDK, kubectl or Perl binaries; any future binary distribution must carry the relevant notices and comply with their licenses.

## Project origin

This standalone workbench evolved from the author's `devops-toolkit` and `arthas-mcp-server` experiments. The prototype reimplements their connection and diagnostic flow in an independent package. The task-mode client follows the wire behavior exercised by those experiments, including `tools/call` with task metadata and `tasks/result` polling. It does not vendor either old project's source tree or import it at runtime.

Any future migration of source or assets from another repository must preserve required copyright and license notices. Do not infer that a directory is freely redistributable merely because it is locally available.

## Names and screenshots

Arthas, Kubernetes and other product names remain the property of their respective owners. This is an independent community project, not an official Alibaba or Kubernetes product. Screenshots and static preview data in this repository were produced from simulated targets; no customer environments or credentials are included.
