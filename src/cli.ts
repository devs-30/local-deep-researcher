import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { config as loadDotenv } from "dotenv";
import { HELP, parseCliArgs, type CliCommand } from "./cli-args";
import { ConfigurationError, ensureConfiguration, validateConfiguration } from "./configuration";
import { PreflightError, preflightAgentModel, preflightOllama } from "./preflight";
import { research, researchAgentic } from "./research";
import { runMcpServer } from "./mcp";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  loadDotenv({ quiet: true });

  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  if (command.kind === "help") {
    console.log(HELP);
    return 0;
  }
  if (command.kind === "version") {
    const require = createRequire(import.meta.url);
    console.log((require("../package.json") as { version: string }).version);
    return 0;
  }
  if (command.kind === "mcp") {
    try {
      await runMcpServer();
      return 0;
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      return 1;
    }
  }

  const { options } = command;
  let started = false;
  try {
    const cfg = ensureConfiguration({ configurable: options.configurable });
    validateConfiguration(cfg);
    if (command.kind === "agent" && !options.quiet) {
      console.error(
        `[agent] search: ${cfg.searchApi} | model: ${cfg.agentLlm ?? cfg.localLlm} | budget: ${cfg.maxAgentSteps} steps`,
      );
    }
    await preflightOllama(cfg);
    if (command.kind === "agent") await preflightAgentModel(cfg);
    started = true;
    const runner = command.kind === "agent" ? researchAgentic : research;
    const report = await runner(options.topic, options.configurable, {
      onProgress: (event) => {
        if (options.quiet) return;
        if (event.step !== undefined) {
          console.error(`[${event.phase}] step ${event.step}/${event.maxSteps}`);
        } else {
          console.error(`[${event.phase}] loop ${event.loop}/${event.maxLoops}`);
        }
      },
    });
    const output = options.json
      ? JSON.stringify({ summary: report.summary, sources: report.sources }, null, 2)
      : report.markdown;
    if (options.output) {
      writeFileSync(options.output, output + "\n");
      if (!options.quiet) console.error(`Report written to ${options.output}`);
    } else {
      console.log(output);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof PreflightError) {
      console.error(`Error: ${(error as Error).message}`);
      return 1;
    }
    console.error(`Research failed: ${(error as Error).message}`);
    return started ? 2 : 1;
  }
}
