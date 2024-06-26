import { assert } from "./_deps.ts";
import { args, command, input } from "./_sdk/mod.ts";

if (import.meta.main) {
  main();
}

export async function main() {
  const bin = input.getOptional<string>("bin") ?? args.get("bin") ?? "bash";
  const script = input.getOptional<string>("script");
  const binArgs = input.getOptional("args", []) as string[] | undefined;

  if (script) {
    const cmd = await command.create(bin, {
      args: binArgs,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "piped",
    });

    const child = cmd.spawn();

    // write the script to the childprocess as stdin
    const writer = child.stdin.getWriter();
    writer.write(new TextEncoder().encode(script));
    writer.releaseLock();

    await child.stdin.close();

    const { code } = await child.output();

    Deno.exit(code);
  }

  assert(bin, "bin must be provided");
  assert(Array.isArray(binArgs), "args must be an array");

  const result = await command.execute(bin, {
    args: binArgs as string[],
  });

  Deno.exit(result.code);
}
