
_scrape_complete() {
    # The generated function scans for subcommands anywhere before the cursor.
    # Only the first argument can be a subcommand in scrape.
    local -a COMP_WORDS=("${COMP_WORDS[@]}")
    local index
    if [[ "${COMP_WORDS[1]-}" != completion ]]; then
        for ((index = 2; index < COMP_CWORD; index++)); do
            if [[ "${COMP_WORDS[index]}" == completion ]]; then
                COMP_WORDS[index]=''
            fi
        done
    fi
    _scrape "$@"
}

if [[ "${BASH_VERSINFO[0]}" -gt 4 || ( "${BASH_VERSINFO[0]}" -eq 4 && "${BASH_VERSINFO[1]}" -ge 4 ) ]]; then
    complete -F _scrape_complete -o nosort -o bashdefault -o default scrape
else
    complete -F _scrape_complete -o bashdefault -o default scrape
fi
