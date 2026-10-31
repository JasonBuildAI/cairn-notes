---
title: "Linux, Containers, and Deployment"
description: "From processes, permissions, and file systems, to images, Kubernetes, CI/CD, and roll-back deployments."
---

Deployment is not just uploading code to a server. It involves putting a specific build artifact into a controlled runtime environment, configuring the network, permissions, resources, and data migration, verifying that it truly works, and keeping a rollback path.

Linux, containers, and orchestration systems address the same set of problems at different layers: how processes run, how resources are isolated and limited, how multiple instances are scheduled, and how releases can be repeated.

## 1. The Four Core Objects of Linux

### 1.1 Files and Mounts

Linux organizes devices and directories into a tree, with common directories each having their responsibilities:

| Directory | Content |
| --- | --- |
| `/bin`, `/usr/bin` | Basic executable files |
| `/etc` | System and application configurations |
| `/var` | Logs, caches, databases, and other variable data |
| `/home` | User directories |
| `/tmp` | Temporary files, which may be cleared |
| `/proc`, `/sys` | Runtime status exposed by the kernel |
| `/dev` | Device files |

Production application data should not only be stored in the container's writable layer or temporary directories. Logs, databases, and uploaded files should be mounted to persistent volumes or object storage.

### 1.2 Permissions

File permissions usually consist of read/write/execute bits for the owner, the group, and others. `chmod` changes permissions, `chown` changes ownership. The execute bit on a directory indicates whether it can be entered or traversed.

```bash
ls -l
chmod 640 .env
chown app:app /srv/app/config.yml
```

Do not use `chmod 777` to solve permission issues. It allows all users to write and may increase the attack surface. Services should run as the least privilege user, not the default root.

### 1.3 Processes

Each process has a PID, parent process, user, open files, environment variables, and resource limits. Common observation commands:

```bash
ps aux
top
ss -ltnp
lsof -p <pid>
```

The process should gracefully exit upon receiving `SIGTERM`; `SIGKILL` cannot be caught and can only be forcibly terminated. A similar signal mechanism is followed when the container stops, and the application should properly handle termination and complete cleanup.

### 1.4 systemd and Services

systemd manages service startup, dependencies, restarting, and logging. A service unit usually declares:

```ini
[Unit]
Description=Example API
After=network.target

[Service]
User=app
WorkingDirectory=/srv/app
ExecStart=/srv/app/server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

When troubleshooting services, first look at:

```bash
systemctl status example
journalctl -u example -n 100 --no-pager
```

Exit codes, startup parameters, working directories, user permissions, and logs are usually more useful than the phrase "the service didn't start." 

## 2. Containers Are Not Lightweight Virtual Machines

Containers share the host kernel, isolate processes, networks, mount points, hostnames, and users through **namespaces**, and limit CPU, memory, and I/O through **cgroups**. They do not start a full guest operating system like virtual machines, so they are lighter, but the isolation boundaries rely more on kernel configuration.

### 2.1 Images and Layers

Images consist of read-only layers, and containers add a writable layer on top of the image. Each instruction in a Dockerfile usually forms a layer, and the build cache reuses layers that have not changed.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

First copy and install dependency files, then copy the source code to better utilize caching. Production images should try to:

- Use a base image with a specific version, rather than always `latest`.
- Install dependencies from the lock file.
- Run as a non-root user.
- Clean up build tools and caches.
- Copy only the files required for running.
- Record the image digest to ensure that deployed artifacts are traceable.

### 2.2 Container Networking

Within a container, `localhost` refers to the container itself, not the host. Containers usually communicate with each other through service names on the same network. Port mapping forwards host ports to container ports, but "container not started," "port not mapped," and "application only listening on loopback" are different issues.

Service discovery in container orchestration usually uses DNS names, such as `db:5432`. If a service name resolution fails, first check the network, DNS, and whether the service is registered.

### 2.3 Data and Lifecycle

The writable layer of a container disappears when the container is deleted. Persistent data should be placed in:

- Data volumes.
- Host bind mounts.
- Object storage.
- Managed databases.

Do not put database files in the container's temporary layer, and do not rely on "data still exists after the container restarts" in production.

### 2.4 Docker Compose

Compose is suitable for local development and single-machine multi-service orchestration:

```yaml
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
    depends_on:
      - db
  db:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

`depends_on` Only the startup order is guaranteed; it does not guarantee that the database has accepted connections. Applications need to retry connections or perform health checks. Compose is not a production high-availability platform; multi-instance scheduling, rolling updates, and failover should be handled by the orchestration system or managed services.  

## 3. Core Model of Kubernetes  

Kubernetes declares "what to run, how many replicas, and how to access" as objects, and the control plane continuously adjusts the actual state to match the desired state.  

### 3.1 Main Objects  

| Object | Purpose |  
| --- | --- |  
| Pod | The smallest deployment unit, containing one or more containers |  
| Deployment | Manages stateless replicas and rolling updates |  
| Service | Provides a stable access entry for a set of Pods |  
| Ingress/Gateway | Routes external HTTP to services |  
| ConfigMap | Non-sensitive configuration |  
| Secret | Encapsulates sensitive configuration, still requires encryption and permissions |  
| StatefulSet | Instances with stable identity and storage needs |  
| Job/CronJob | One-time or scheduled tasks |  

### 3.2 Control Plane  

The control plane includes the API Server, scheduler, controllers, and state storage. The scheduler selects nodes, controllers compare the desired state with the actual state, and etcd stores cluster state. Worker nodes run the container runtime and kubelet.  

If the cluster loses a majority of control plane nodes, existing Pods may continue running, but scheduling and updates cannot be reliably performed. Managed Kubernetes handles part of the control plane for you, but worker nodes, network, storage, and application configuration remain your responsibility.  

### 3.3 Scheduling and Resources

```yaml
resources:
  requests:
    cpu: "250m"
    memory: "256Mi"
  limits:
    cpu: "1"
    memory: "512Mi"
```

`requests` is used for scheduling and ensuring resources, `limits` is used to limit the upper limit. Exceeding the memory limit may result in termination, exceeding the CPU limit will cause throttling. Setting it too low will lead to frequent restarts, setting it too high will waste capacity. Adjustments should be made according to actual metrics.

### 3.4 Health Checks

- **liveness**: Restart when the process is stuck.
- **readiness**: Join the Service when ready to receive traffic.
- **startup**: Prevent slow-start applications from being mistakenly killed during the initialization phase.

Health checks should only verify whether "this instance can work" and should not be made into a full business chain monitoring. If dependent databases fluctuate briefly and all instances are marked unhealthy simultaneously, it can cause greater failures.

### 3.5 Deployment

Deployment supports rolling updates by default. Key parameters:

- Maximum unavailable replicas.
- Maximum surge replicas.
- How long after the new version is ready to receive traffic.
- Whether to automatically roll back on failure.

Before deployment, ensure database migrations are backward-compatible, because new and old Pods will coexist briefly.

## 4. CI/CD

Continuous Integration (CI) automatically builds and validates after code changes. Continuous Delivery/Deployment (CD) sends the verified artifacts to environments.

### 4.1 Pipeline Stages

```text
Pull code
  Format/Static Check
  Unit Test
  → Build Artifacts/Images
  Scan Dependencies and Images
  Deploy test environment
  → Integration/End-to-End Testing
  → Generate change log
  Manual or automatic approval
  → Deploy to Production
  Health Check/Verification
```

Each stage should produce traceable results. Simply displaying 'pipeline failed' without keeping logs, test reports, and failed artifacts will slow down troubleshooting.

### 4.2 Build Once, Deploy the Same Artifact

Development, testing, and production should use the same build artifact as much as possible, only changing configurations and keys. If each environment rebuilds, differences in code, dependencies, and build tools will make 'tests passed' meaningless.

Images or artifacts should carry version, commit hash, and build time. Record the actual digest during deployment, not just the variable tags.

### 4.3 Database Migration

Deployment order should be clear:

1. First, perform backward-compatible schema migrations.
2. Then deploy applications compatible with both old and new schemas.
3. Backfill or dual-write.
4. Switch reads.
5. Finally remove old fields.

Rolling back an application is not the same as rolling back the database. Deleting columns and changing types require extra caution and usually require multi-stage migrations.

### 4.4 Secrets

Keys in CI/CD should be stored in a controlled key management system, isolated by environment and purpose. Tokens must not be printed in logs; build artifacts must not contain production keys; temporary credentials must be short-lived.

## 5. Deployment Strategies

| Strategy | Approach | Risk |
| --- | --- | --- |
| Rolling | Replace old instances gradually | New and old versions coexist, compatibility required |
| Blue-Green | Switch traffic between two environments | High resource cost, data still needs compatibility |
| Canary | Start with a small percentage of users | Requires traffic splitting and metric comparison |
| Feature Toggle | Code is deployed but feature is off | Accumulation of toggles and complex state combinations |
| Shadow Traffic | Duplicate requests to the new version without affecting users | Write operations and external side effects must be isolated |

Regardless of method, metrics need to be verified: error rate, latency, key business success rate, and resource usage. Deployment completion does not equal health, observation over time is required.

## 6. Rollback

Rollback-capable deployments must meet:

- Old images/artifacts are still accessible.
- Configurations and keys have versions.
- Database changes are compatible with the old version.
- Rollback does not require manual changes on multiple machines.
- Core metrics can be verified after rollback.

'Deleting the new version and redeploying the old version' may be too slow. Blue-green switches, traffic rollback, or keeping a copy of the previous version can reduce recovery time.

## 7. Common Failures in Running Systems

| Symptom | Priority Checks |
| --- | --- |
| Container exits immediately | Start command, configuration, permissions, dependencies |
| Service restart loop | Memory limit, liveness, startup time |
| External access 502 | Service, Ingress, container ports, application listeners |
| Certain instance receives no traffic | Readiness, label selectors, network policies |
| Errors increase after deployment | New and old versions, database migration, configuration differences |
| Node disk full | Log rotation, image cache, volume capacity |
| Latency sudden increase | Node resources, dependencies, connection pool, network |

## Checklist

- Are applications running as least-privilege users?
- Are data, logs, and temporary files stored in the correct locations?
- Are images version-locked and containing only what is needed to run?
- Are containers listening on the correct addresses and ports?
- Are Kubernetes requests/limits, probes, and replica counts justified?
- Are configurations and secrets separated, and do they support versioning and auditing?
- Does CI include checks, tests, builds, scans, and artifact records?
- Is deployment built once and the same artifact reused?
- Are database migrations compatible with rolling release and rollback?
- Are there canary releases, verified metrics, and clear rollback paths?
