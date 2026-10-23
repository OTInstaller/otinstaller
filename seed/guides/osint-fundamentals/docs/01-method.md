# The method

Most investigations follow the same six stages. They loop: a finding in stage 3 often sends you back to stage 2 with
a new identifier. Keep the loop inside your scope.

## 1. Scope

Write down, before you run anything:

- **The question.** "Is the seller in this marketplace listing the same person as this forum account?" is a scope.
  "Everything about them" is not.
- **Why you may ask it.** Your role and the reason: a newsroom story, a fraud case, due diligence you were hired for.
- **What is out of bounds.** Family members, private accounts, anything that needs a login you are not entitled to.
- **When you are done.** The answer, or the point at which you would need more than public information.

## 2. Collect

Start from the identifiers you already have. Use passive sources first: tools that run offline, or read public
records and search results without sending anything to the person or their services. Every tool page in the registry
says what a run reaches under **Behaviour**, and the comparison table on each input page (for example
[email tools](https://otinstaller.com/input/email)) lays it out side by side.

Collect the source with every fact: the URL, the date you saw it, and the tool and version that found it.

## 3. Pivot

A result usually holds new identifiers: an email address in a profile, a domain in that address, a username in a bio,
coordinates in a photo. Each one is a new starting point. `ot pivot <run-id>` lists the tools that take what a saved
run found, and every tool page has a **What next** list.

Before each pivot, ask whether it still serves the question in your scope.

## 4. Verify

A hit is a lead, not an identification. A username search tells you a page exists, not who runs it; a photo match
tells you two images are alike, not that they show the same moment.

- Look for **at least two independent links** to what you already know: the same photo, a link from an account you
  already attributed, the same unusual detail.
- **Grade each finding**: confirmed, likely or unrelated, with one line on why.
- **Grade the source too**: how reliable has it been, and could anyone have planted or edited what it shows?

## 5. Record

Write as you go, not at the end. [Recording and reporting](04-record-and-report.md) shows a log format and what `ot`
saves for you.

## 6. Report

Answer the question you wrote in stage 1: what you found, how sure you are, how you know, and what you could not
establish. Then delete what you collected and no longer need.
