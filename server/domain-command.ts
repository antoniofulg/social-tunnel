import { isAbsolute } from "node:path";
import { forwardDomainCommand } from "./domain-ingress";

if (import.meta.main) {
  const path = process.argv[2];
  // Supplied only by trusted sshd ForceCommand, never concatenated with SSH_ORIGINAL_COMMAND.
  const command = process.env.SSH_ORIGINAL_COMMAND;
  if (process.argv.length !== 3 || !path || !isAbsolute(path) || process.geteuid?.() === 0) process.exit(1);
  const sent = await forwardDomainCommand(path, command, process.stdin, (data) => new Promise<void>((resolve, reject) => {
    process.stdout.write(data, (error) => error ? reject(error) : resolve());
  }));
  process.exit(sent ? 0 : 1);
}
