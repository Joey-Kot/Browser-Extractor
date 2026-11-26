use std::{
    env,
    io::{self, Write},
    process::ExitCode,
};

use clap::{value_parser, Arg, Command, CommandFactory};
use clap_complete::{
    env::{EnvCompleter, Fish},
    CompleteEnv, Generator, Shell,
};
use extractor_cli::Cli;

const BIN: &str = "scrape";
const ENV_VAR: &str = "SCRAPE_COMPLETE";

pub(crate) fn complete_from_env() {
    CompleteEnv::with_factory(|| {
        // The adapter passes `-- scrape [words...]`. A leading option selects
        // extraction, where a later `completion` can be an option value.
        let first_arg = env::args_os().skip_while(|arg| arg != "--").nth(2);
        if first_arg.is_some_and(|arg| arg.as_encoded_bytes().starts_with(b"-")) {
            Cli::command()
        } else {
            command()
        }
    })
    .var(ENV_VAR)
    .complete();
}

pub(crate) fn command() -> Command {
    Cli::command()
        .subcommand_negates_reqs(true)
        .args_conflicts_with_subcommands(true)
        .disable_help_subcommand(true)
        .subcommand(
            Command::new("completion")
                .about("Generate a shell completion script")
                .arg(
                    Arg::new("shell")
                        .value_name("SHELL")
                        .required(true)
                        .value_parser(value_parser!(Shell)),
                ),
        )
}

pub(crate) fn run(shell: Shell) -> ExitCode {
    if let Err(error) = write_script(shell, &mut io::stdout().lock()) {
        eprintln!("failed to write completion script: {error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn write_script(shell: Shell, output: &mut dyn Write) -> io::Result<()> {
    match shell {
        Shell::PowerShell => output.write_all(include_bytes!("completion.ps1")),
        Shell::Elvish => output.write_all(include_bytes!("completion.elv")),
        Shell::Fish => {
            Fish.write_registration(ENV_VAR, BIN, BIN, BIN, output)?;
            // Fish handles quoting and escaping in filesystem completions.
            writeln!(output, "complete -c scrape -s p -l path -x -d 'Output directory' -a '(__fish_complete_directories)'")
        }
        _ => {
            let mut command = command().bin_name(BIN);
            command.build();
            shell.try_generate(&command, output)?;
            if shell == Shell::Bash {
                output.write_all(include_bytes!("completion.bash"))?;
            }
            Ok(())
        }
    }
}
