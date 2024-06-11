import { Job } from "./job.ts";
import type { Workflow } from "../types.ts";
import {
  resolveActionUrlForDenoCommand,
  resolveActionUrlFromDefinition,
} from "../libs/resolve-action-url.ts";
import { State } from "../libs/state.ts";
import { Folder } from "../libs/folder.ts";
import {
  evaluateExpress,
  isExpressionResultTruthy,
  makeEvaluableExpression,
} from "../libs/expression.ts";
import {
  parseVariableFile,
  replaceVariablePlaceholdersInVariables,
} from "../libs/variables.ts";

import { assert, stripAnsiCode } from "../deps.ts";
import { ExecuteDenoRunOptions } from "../libs/deno/execute.ts";
import { stepHasRun } from "../libs/config-helpers.ts";
import { StateName } from "../constants.ts";
import { denoMergePermissions } from "../libs/deno/permissions.ts";

export class Step extends State {
  readonly id: string;
  readonly name: string;

  public actionUrl: URL | null = null;

  #contextDir: Folder | null = null;

  constructor(
    public readonly job: Job,
    public readonly def: Workflow.Step,
  ) {
    super();
    this.id = this.shortId("step");
    this.name = def.name ?? this.id;
  }

  get contextDir(): Folder {
    assert(this.#contextDir !== null, "Context dir not set");
    return this.#contextDir;
  }

  get logger() {
    return this.job.logger;
  }

  getCombinedState() {
    return {
      ...super.getCombinedState(),
      definition: this.def,
    };
  }

  getContext(): Record<string, unknown> {
    return {
      name: this.name,
      outputs: this.getState(StateName.Outputs, {}),
      status: this.state.status,
      result: this.state.result,
    };
  }

  async evaluateExpress(expression: string): Promise<string> {
    const ctx = {
      step: this.getContext(),
      job: this.job.getContext(),
      steps: this.job.steps.reduce((acc, step) => {
        if (step.id === this.id) {
          return acc;
        }
        return {
          ...acc,
          [step.name]: step.getContext(),
        };
      }, {}),
    };

    return await evaluateExpress(expression, ctx);
  }

  async prepare(): Promise<void> {
    this.#contextDir = await this.job.contextDir.mkdir(this.id);

    this.actionUrl = await resolveActionUrlFromDefinition(this.def, {
      stdPrefix: this.job.execution.manager.options.stdActionsPrefix,
    });
  }

  async execute(): Promise<void> {
    assert(this.actionUrl, "Action URL not resolved");

    try {
      this.start();

      // check to see if this step should be skipped
      const shouldSkip = !isExpressionResultTruthy(
        await this.evaluateExpress(
          makeEvaluableExpression(this.def.when ?? "true"),
        ),
      );

      if (shouldSkip) {
        await this.skip('Step was skipped due to "if" condition');
        return;
      }

      const outputFilePath = await this.contextDir.writeText(
        this.shortId("set-output"),
        "",
      );
      const envFilePath = await this.contextDir.writeText(
        this.shortId("set-env"),
        "",
      );

      const stdout_: string[] = [];
      const stderr_: string[] = [];

      const stdout = new WritableStream({
        write: (chunk) => {
          const txt = stripAnsiCode(new TextDecoder().decode(chunk)).trim();
          this.logger.info(`  > [stdout] ${txt}`);
          stdout_.push(txt);
        },
      });

      const stderr = new WritableStream({
        write: (chunk) => {
          const txt = stripAnsiCode(new TextDecoder().decode(chunk)).trim();
          this.logger.error(`  > [stderr] ${txt}`);
          stderr_.push(txt);
        },
      });

      const runFile = resolveActionUrlForDenoCommand(this.actionUrl);
      const runOptions = await this._getDenoRunOptions({
        env: {
          ELWOOD_OUTPUT: outputFilePath,
          ELWOOD_ENV: envFilePath,
        },
      });

      this.job.execution.manager.logger.info(
        ` > running step: ${this.name}[${this.id}]`,
      );
      this.job.execution.manager.logger.info(`  > file: ${runFile}`);
      this.job.execution.manager.logger.info(
        `  > options: ${JSON.stringify(runOptions, null, 2)}`,
      );

      const result = await this.job.execution.executeDenoRun({
        ...runOptions,
        file: runFile,
        cwd: this.contextDir.path,
        stdout: "piped",
        stderr: "piped",
        stderrStream: stderr,
        stdoutStream: stdout,
      });

      this.setState(
        StateName.Outputs,
        await parseVariableFile(await this.contextDir.readText(outputFilePath)),
      );

      this.setState(
        StateName.Env,
        await parseVariableFile(await this.contextDir.readText(envFilePath)),
      );

      this.setState(StateName.Stdout, stdout_);
      this.setState(StateName.Stderr, stderr_);

      switch (result.code) {
        case 0: {
          await this.succeed();
          break;
        }
        default: {
          await this.fail(`Action failed with code ${result.code}`);
          await this.job.fail(`Step ${this.name} failed`);
        }
      }
    } catch (error) {
      await this.fail(error.message);
    } finally {
      this.stop();
    }
  }

  async _getDenoRunOptions(
    init: Omit<ExecuteDenoRunOptions, "file" | "cwd"> = {},
  ): Promise<Omit<ExecuteDenoRunOptions, "file" | "cwd">> {
    const commandInputEnv = await this._getCommandInputEnv();
    const argsFromActionUrl: Record<string, string> = {};
    const defPermissions = this.def.permissions ?? {} as Workflow.Permissions;

    // if the action has search params
    // pass them to the action as ARG_ env variables
    if (this.actionUrl?.searchParams) {
      for (const [name, value] of this.actionUrl.searchParams.entries()) {
        argsFromActionUrl[`ARG_${name.toUpperCase()}`] = value;
      }
    }

    // if the value is an array, merge it with the append array
    // otherwise return the value.
    function _arrayOrTrue(
      value: string[] | boolean | undefined,
      append: Array<string | undefined>,
    ): string[] | boolean {
      if (value === false) {
        return value;
      }

      return [
        ...(Array.isArray(value) ? value : []),
        ...append.filter(Boolean) as string[],
      ];
    }

    const env = {
      ...(init.env ?? {}),
      ...argsFromActionUrl,
      ...commandInputEnv,
    };

    if (stepHasRun(this.def)) {
      env.INPUT_BIN = this.def.input?.bin ?? "bash";
      env.INPUT_SCRIPT = this.def.run;

      defPermissions.run = _arrayOrTrue(
        [env.INPUT_BIN],
        Array.isArray(defPermissions.run) ? defPermissions.run : [],
      );
    }

    return {
      ...init,
      permissions: denoMergePermissions(defPermissions, {
        read: [
          init.env?.ELWOOD_ENV,
          init.env?.ELWOOD_OUTPUT,
          this.contextDir.path,
          this.job.execution.stageDir.path,
          "<CWD>",
        ],
        write: [
          init.env?.ELWOOD_ENV,
          init.env?.ELWOOD_OUTPUT,
          this.contextDir.path,
          this.job.execution.stageDir.path,
          this.job.execution.binDir.path,
        ],
        env: [
          ...Object.keys(env),
        ],
      }),
      env: await replaceVariablePlaceholdersInVariables(env),
    };
  }

  async _getCommandInputEnv(): Promise<Record<string, string>> {
    const withDefinition = this.def.input ?? {};
    const inputEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries(withDefinition)) {
      inputEnv[`INPUT_${key.toLocaleUpperCase()}`] = await this.evaluateExpress(
        value,
      );
    }

    return inputEnv;
  }
}
