use std::{error::Error, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Usage,
    Runtime,
}

#[derive(Debug)]
pub struct CliError {
    kind: ErrorKind,
    message: String,
}

impl CliError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Usage,
            message: message.into(),
        }
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Runtime,
            message: message.into(),
        }
    }

    pub fn exit_code(&self) -> i32 {
        match self.kind {
            ErrorKind::Usage => 2,
            ErrorKind::Runtime => 1,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CliError {}
