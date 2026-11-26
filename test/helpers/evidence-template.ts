// docs/EVIDENCE.md as it was before any row was recorded: the same file with every data row of its network tables taken out, and nothing else
// changed (the headings, the column headers and the line endings stay). A test that needs a pristine evidence file to build on, to add a row
// to, or to point a command at starts from this, so that a real row recorded in docs/EVIDENCE.md later does not change what the test is about,
// and a test never reads the real chain because of one.
//
// A data row is a line that starts with a UTC date, the way the recorder writes it. The column-meaning table above the network tables starts
// each line with a column name, so it is left alone.
export function evidenceTemplate(text: string): string {
  return text.replace(/^\| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \|[^\n]*\r?\n/gm, "");
}
