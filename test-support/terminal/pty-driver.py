import os
import pty
import select
import sys


if len(sys.argv) < 2:
    raise SystemExit("usage: session-pty-driver.py COMMAND [ARGS]")


def write_all(file_descriptor, data):
    while data:
        data = data[os.write(file_descriptor, data):]


def copy_until_child_exit(master_fd):
    standard_input = sys.stdin.fileno()
    inputs = [master_fd, standard_input]
    while master_fd in inputs:
        readable, _, _ = select.select(inputs, [], [])
        if master_fd in readable:
            try:
                data = os.read(master_fd, 1024)
            except OSError:
                break
            if not data:
                break
            write_all(sys.stdout.fileno(), data)
        if standard_input in readable:
            data = os.read(standard_input, 1024)
            if data:
                try:
                    write_all(master_fd, data)
                except OSError:
                    break
            else:
                inputs.remove(standard_input)


pid, master_fd = pty.fork()
if pid == pty.CHILD:
    os.execv(sys.argv[1], sys.argv[1:])

print(f"MAREA_PTY_CHILD_PID={pid}", file=sys.stderr, flush=True)
try:
    copy_until_child_exit(master_fd)
finally:
    os.close(master_fd)

status = os.waitpid(pid, 0)[1]
raise SystemExit(os.waitstatus_to_exitcode(status))
