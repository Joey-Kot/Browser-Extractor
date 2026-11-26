mod completion;

use std::process::ExitCode;

use clap::{error::ErrorKind, FromArgMatches};
use clap_complete::Shell;
use extractor_cli::{execute, Cli};

fn main() -> ExitCode {
    completion::complete_from_env();

    let mut matches = match completion::command().try_get_matches() {
        Ok(matches) => matches,
        Err(error) => {
            let is_help = matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            );
            if std::env::args_os()
                .nth(1)
                .is_some_and(|arg| arg == "completion")
            {
                error.exit();
            }
            let rendered = error.to_string();
            let reason = rendered
                .lines()
                .take_while(|line| !line.trim().is_empty())
                .enumerate()
                .map(|(index, line)| {
                    if index == 0 {
                        line.trim_start_matches("error: ")
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let _ = error.print();
            if is_help {
                return ExitCode::SUCCESS;
            }
            println!("false");
            println!(
                "{}",
                if reason.is_empty() {
                    "invalid command-line arguments"
                } else {
                    &reason
                }
            );
            return ExitCode::from(2);
        }
    };

    if let Some(args) = matches.subcommand_matches("completion") {
        let shell = *args.get_one::<Shell>("shell").expect("shell is required");
        return completion::run(shell);
    }

    let cli = Cli::from_arg_matches_mut(&mut matches).unwrap_or_else(|error| error.exit());
    scrape(cli)
}

#[tokio::main]
async fn scrape(cli: Cli) -> ExitCode {
    match execute(cli).await {
        Ok(_) => {
            println!("true");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("false");
            println!("{error}");
            ExitCode::from(error.exit_code() as u8)
        }
    }
}
