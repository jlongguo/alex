# Fix Docker volume EACCES

A fresh `sim_node_modules` named volume is owned by root. Alex's Compose sim
service uses the host UID:GID, so `npm install` cannot create TypeScript files.

The updated `docker-sim.sh` initializes the volume automatically before any
command that uses it. A one-shot root container receives only CAP_CHOWN and
changes ownership **only** of `/workspace/alex/node_modules`. It exits before
the normal nonroot npm / ROS commands run. The host source, host node_modules,
simulation report files, device data and other volumes are not changed.

Manual one-shot repair if you have not applied the updated script:

```bash
export ALEX_DOCKER_UID="$(id -u)" ALEX_DOCKER_GID="$(id -g)"
docker compose -f docker-compose.sim.yml run --rm -T --no-deps \
  --user 0:0 --cap-add CHOWN sim \
  chown -R "${ALEX_DOCKER_UID}:${ALEX_DOCKER_GID}" /workspace/alex/node_modules
bash scripts/docker-sim.sh check
```

Do not use `chmod -R 777` or `docker compose down -v` to fix ownership.
Do not interpret npm/Compose success as real Gazebo/Nav2 acceptance.