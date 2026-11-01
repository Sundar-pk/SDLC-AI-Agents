This is new functionality. Build it test-first from the acceptance criteria. Follow the existing structure of the closest module rather than inventing a new one.

## jira_reader
Acceptance criteria are the contract. If the ticket has none, write them from the description and mark them `(inferred)`. Mockups or screenshots in the attachments define the screens: note which screens are described.

## spec_agent
Describe the new behaviour only. List each new endpoint, event, screen or table as its own item. Reuse existing services and components where `context.md` shows them; say which ones.

## planner
Order the work as vertical slices (one behaviour end to end) so each slice can be tested and reviewed alone. Prefer extending existing classes over adding new layers.

## test_author
Start with the happy path of each acceptance criterion, then validation, errors and boundaries. All tests are new.

## code_reviewer
Check that nothing outside the ticket's scope was added, and that new code follows the patterns of its neighbours.

## mr_agent
Describe the capability added and how a reviewer can try it.
