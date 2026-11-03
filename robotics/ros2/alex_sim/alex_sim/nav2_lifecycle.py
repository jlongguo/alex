"""ROS-independent Nav2 lifecycle readiness guard.

The NavigateToPose action can advertise before bt_navigator reaches ACTIVE.
Only a completed /bt_navigator/get_state response reporting state ID 3,
together with a ready ActionClient, permits goal submission.
"""

ACTIVE_STATE_ID = 3


class Nav2LifecycleGate:
    def __init__(self, poll_interval=0.5, response_timeout=5.0):
        if poll_interval <= 0 or response_timeout <= 0:
            raise ValueError("INVALID_LIFECYCLE_POLL_INTERVAL")
        self.poll_interval = float(poll_interval)
        self.response_timeout = float(response_timeout)
        self.pending = None
        self.pending_since = None
        self.next_poll = 0.0
        self.last_state_id = None
        self.last_state_label = "unknown"
        self.last_error = None
        self.response_count = 0
        self.active_response_count = 0

    def poll(self, *, now, service_ready, action_ready, request_state):
        if self.pending is not None:
            if self.pending.done():
                future = self.pending
                self.pending = None
                self.pending_since = None
                try:
                    state = future.result().current_state
                    self.last_state_id = int(state.id)
                    self.last_state_label = str(state.label)
                    self.response_count += 1
                    self.last_error = None
                    if self.last_state_id == ACTIVE_STATE_ID:
                        self.active_response_count += 1
                        if action_ready:
                            return True
                except Exception as exc:
                    self.last_state_id = None
                    self.last_state_label = "unavailable"
                    self.last_error = type(exc).__name__
            elif now - self.pending_since >= self.response_timeout:
                self.pending.cancel()
                self.pending = None
                self.pending_since = None
                self.last_error = "GET_STATE_RESPONSE_TIMEOUT"
            else:
                return False

        if service_ready and now >= self.next_poll:
            self.next_poll = now + self.poll_interval
            try:
                self.pending = request_state()
                self.pending_since = now
            except Exception as exc:
                self.last_error = type(exc).__name__
        return False

    def snapshot(self):
        return {
            "node": "/bt_navigator",
            "service": "/bt_navigator/get_state",
            "state_id": self.last_state_id,
            "state_label": self.last_state_label,
            "last_error": self.last_error,
            "responses": self.response_count,
            "active_responses": self.active_response_count,
            "pending_request": self.pending is not None,
        }
