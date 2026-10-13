# Connection interruptions

The model-visible descriptions of `wait_task`, `continue_work` and `run_temp`, together with the MCP server instructions, carry the same connection recovery rule. After three consecutive connection interruptions, request timeouts without a valid response, or host-unreachable errors across Bridge calls, the assistant stops automatic retries and polling. Switching tools does not start a new retry budget. A valid `wait_task` response with `ready=false` is ordinary waiting and resets the failure count.

The assistant first reports verified completed work, unfinished items and known `work_id`, `task_id` and `thread_id` values. It then explains that the computer may be powered off or Bridge may be offline, asks the user to power on or reconnect and reply `继续`, and waits for that reply. A lost start response is not permission to replay `continue_work` or `run_temp`.

After `继续`, make one read-only check of the original task. If that check fails, report the result and wait again. If the task is no longer available after a restart, inspect its saved work record and existing artifacts before determining the remaining work. Resume the same durable work and original native thread after confirming the earlier execution is inactive; temporary work has no persistent thread to resume.

These are persistent model instructions, not a server-side retry counter or task termination mechanism. They do not cancel running executions, alter the existing executor deadlines or delete history. Deploy the updated build through the normal restart procedure when active work has finished, then refresh ChatGPT's tool list; running connections keep their previous metadata until updated.
