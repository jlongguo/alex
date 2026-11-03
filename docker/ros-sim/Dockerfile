# Alex simulation-only image. ROS 2 Jazzy on Ubuntu 24.04 (Noble).
# ROS/Gazebo run within one container; this image must never access robot hardware.
FROM node:22-bookworm-slim AS nodejs

FROM ros:jazzy-ros-base-noble
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Use an official Node 22 build without adding a second apt repository.
COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=nodejs /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ros-jazzy-ros-gz \
      ros-jazzy-navigation2 \
      ros-jazzy-nav2-bringup \
      ros-jazzy-robot-state-publisher \
      ros-jazzy-tf2-ros \
      python3-colcon-common-extensions \
      python3-yaml \
      util-linux \
      libegl1 \
      libgl1 \
      libgl1-mesa-dri \
      libgbm1 \
    && rm -rf /var/lib/apt/lists/*

ENV ALEX_ROS_SIMULATION_ONLY=1 \
    ALEX_RUN_ROS_INTEGRATION=1 \
    ROS_DOMAIN_ID=77 \
    ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST \
    ALEX_GZ_HEADLESS_RENDERING=1 \
    HOME=/tmp/alex \
    npm_config_cache=/tmp/alex/npm-cache \
    XDG_CACHE_HOME=/tmp/alex/cache

WORKDIR /workspace/alex
# Keep the official ROS entrypoint, which sources /opt/ros/jazzy/setup.bash.
CMD ["bash"]
