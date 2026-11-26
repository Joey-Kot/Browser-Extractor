use std::process::Command;

#[test]
fn option_completion_keeps_output_named_completion_in_extraction_context() {
    for shell in ["fish", "elvish", "powershell"] {
        let output = Command::new(env!("CARGO_BIN_EXE_scrape"))
            .args(["--", "scrape", "-o", "completion", "--m"])
            .env("SCRAPE_COMPLETE", shell)
            .env("_CLAP_COMPLETE_INDEX", "3")
            .env_remove("EXTRACTOR_API_KEY")
            .output()
            .unwrap();

        assert!(output.status.success(), "{shell}: {output:?}");
        let candidates = String::from_utf8(output.stdout).unwrap();
        assert!(
            candidates
                .lines()
                .any(|line| line.split('\t').next() == Some("--mode")),
            "{shell}: {candidates:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn bash_completes_options_after_output_named_completion() {
    let output = Command::new("bash")
        .args([
            "--noprofile",
            "--norc",
            "-c",
            r#"
            set -e
            source <("$SCRAPE_TEST_BIN" completion bash)
            [[ $(complete -p scrape) == *'-F _scrape_complete scrape' ]]
            COMP_WORDS=(scrape -o completion --m)
            COMP_CWORD=3
            _scrape_complete scrape --m completion
            [[ "${COMPREPLY[*]}" == --mode ]]
            "#,
        ])
        .env("SCRAPE_TEST_BIN", env!("CARGO_BIN_EXE_scrape"))
        .env_remove("SCRAPE_COMPLETE")
        .output();

    match output {
        Ok(output) => assert!(output.status.success(), "{output:?}"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("could not run Bash: {error}"),
    }
}
