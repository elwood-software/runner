import { basename, dirname, fromFileUrl, join } from "../deps.ts";

import { stepHasRun } from "./config-helpers.ts";
import type { Workflow } from "../types.ts";

export type ResolveActionUrlOptions = {
  stdPrefix: string;
};

export async function resolveActionUrlFromDefinition(
  def: Workflow.Step,
  options: ResolveActionUrlOptions,
): Promise<URL> {
  if (stepHasRun(def)) {
    return await resolveActionUrl("run", options);
  }

  return await resolveActionUrl(
    (def as Workflow.StepSchemaWithAction).action,
    options,
  );
}

export async function resolveActionUrl(
  action: string,
  options: ResolveActionUrlOptions,
): Promise<URL> {
  if (action.includes("://")) {
    const url = new URL(action);

    switch (url.protocol) {
      case "bin:":
        return new URL(
          `?bin=${url.hostname}`,
          await resolveActionUrl("run", options),
        );

      default:
        return url;
    }
  }

  const base = basename(action);
  const ext = action.endsWith(".ts") ? "" : ".ts";

  return new URL(
    `${options.stdPrefix}/${join(dirname(action), `${base}${ext}`)}`,
  );
}

export function resolveActionUrlForDenoCommand(url: URL): string {
  switch (url.protocol) {
    case "file:":
      return fromFileUrl(url);
    case "http:":
    case "https:":
      return url.href;
    default:
      throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
}
