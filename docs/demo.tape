# Regeneratable source for docs/demo.gif in README.md -- not a black-box asset. Runs the real
# `bskel` binary (via a PATH shim, so the recording shows plain `bskel <command>`, matching what a
# real global-install user types) against a real fixture repo (test/fixtures/java-spring, copied
# into a real disposable git repo with a real origin remote by the wrapper script that invokes this
# tape -- see docs/record-demo.sh). No output shown here is fabricated.
#
# Regenerate with: ./docs/record-demo.sh
Output docs/demo.gif

Require bskel

Set Shell "bash"
Set FontSize 15
Set Width 1160
Set Height 760
Set Padding 20
Set TypingSpeed 35ms
Set Theme "Dracula"

Hide
Type "cd /tmp/bskel-demo-fixture && clear" Enter
Show

Type "bskel preflight" Enter
Sleep 1.2s

Type "bskel feature init --slug organization-management" Enter
Sleep 1.5s

Type "bskel scan --feature 001-organization-management --terms organization" Enter
Sleep 4s

# Disposition's own output is a full content-hash manifest of every scanned source file -- real,
# but too long to usefully watch scroll by in a short demo. The command still genuinely runs; the
# Sleep here must outlast it (hashing ~35 files takes a couple seconds) or its tail leaks past Show.
Hide
Type "bskel scan disposition --feature 001-organization-management --mode reuse --note 'already modeled here, reusing' && clear" Enter
Sleep 3s
Show

Type "bskel status --feature 001-organization-management" Enter
Sleep 4s
