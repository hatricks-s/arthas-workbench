# Security policy

## Support status

This repository is an experimental prototype. Only the current `main` branch receives fixes; there is no supported production release or response-time guarantee.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/yy568821795-max/arthas-workbench/security/advisories/new). Please do not put credentials, usable kubeconfig, private hosts, process dumps or an active-target exploit in a public issue.

Include the affected commit, platform, a minimal reproduction using disposable or simulated targets, expected behavior and impact. An acknowledgement and next steps will be provided as maintainer availability permits; no response SLA is promised.

## Runtime boundaries

- Operate only on JVMs and clusters you are authorized to diagnose.
- User credentials and connector credentials are different. Treat configuration files as secrets.
- The default loopback bind is for development. Remote access requires TLS, a correct public origin, WSS connectors and appropriate network controls.
- The browser cannot enumerate local processes. Native operations are performed by the explicitly installed connector under its OS permissions.
- JVM Attach, diagnostic expressions and instrumentation can affect application behavior. Attach is opt-in and requires explicit target selection.
- Closing a browser does not stop the JVM. Cancelling an Attach wait cannot guarantee undoing an already executed Attach.
- Sessions and tasks are in memory. The prototype lacks production SSO, durable audit, persistent jobs and a hardened multi-replica deployment model.
- Static preview credentials are deliberately nonsecret fixtures, and the preview uses simulated fetch responses only. Never substitute real credentials into published preview assets.

The lockfiles provide repeatable dependencies, not a claim that every dependency has completed a security audit. Do not expose this prototype directly to the public Internet as a production diagnostic service.
