use std::process::ExitCode;

use clap::{error::ErrorKind, Parser};
use extractor_cli::{execute, Cli};

#[tokio::main]
async fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let is_help = matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            );
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
