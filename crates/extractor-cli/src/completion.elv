set edit:completion:arg-completer[scrape] = { |@words|
    tmp E:SCRAPE_COMPLETE = elvish
    tmp E:_CLAP_IFS = "\n"
    tmp E:_CLAP_COMPLETE_INDEX = (to-string (- (count $words) 1))
    put (scrape -- $@words) | to-lines
}
