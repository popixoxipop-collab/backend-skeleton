// D3 (D-scanner-evidence): extracted from python-fastapi.mjs/generic-grep.mjs, which each had
// their own copy of this exact function -- java-spring.mjs needs the same thing now that D3
// requires every adapter to track a line number per evidence-bearing match, not just endpoints.
export function lineNumberAt(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
	return line;
}
