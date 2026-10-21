package agent

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// Entry is one line of the audit log: a side effect an agent (or a caller without a terminal) asked for, and what
// happened. The log stays on this machine; nothing is uploaded.
type Entry struct {
	Time   time.Time `json:"time"`
	Client string    `json:"client"`           // the MCP client's name and version, or cli / ci
	Action string    `json:"action"`           // run, install or uninstall
	Tool   string    `json:"tool"`             // namespace/name@version
	Digest string    `json:"digest,omitempty"` // the image digest or wheel hash
	// Inputs are the input values, unless redact_targets_in_audit; InputsHash is always set.
	Inputs     map[string]string `json:"inputs,omitempty"`
	InputsHash string            `json:"inputs_hash,omitempty"`
	Class      Class             `json:"class,omitempty"`
	// Consent is how the action was allowed: policy, elicitation, session, token, flag (--yes) or sandbox; or why
	// it wasn't: declined, refused.
	Consent  string `json:"consent"`
	Outcome  string `json:"outcome"` // complete, failed, timeout, interrupted, error, refused, declined, installed, uninstalled
	ExitCode *int   `json:"exit_code,omitempty"`
	RunID    string `json:"run_id,omitempty"`
	Duration int64  `json:"duration_ms,omitempty"`
	Error    string `json:"error,omitempty"`
}

// AuditPath is the current audit log; older ones are agent-audit.1.jsonl to .4.jsonl.
func AuditPath() string { return state.Path("agent-audit.jsonl") }

const (
	auditMaxBytes = 10 << 20
	auditKeep     = 5
)

var auditMu sync.Mutex

// HashInputs is a stable hash of a run's inputs, so redacted entries can still be matched up.
func HashInputs(values map[string]string) string {
	h := sha256.Sum256([]byte(targetKey(values)))
	return hex.EncodeToString(h[:8])
}

// Record appends an entry, rotating the log at 10 MB. Failing to write is reported but never stops the action.
func Record(p *Policy, e Entry) error {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	if e.Inputs != nil {
		e.InputsHash = HashInputs(e.Inputs)
		if p != nil && p.RedactTargetsInAudit {
			e.Inputs = nil
		}
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	auditMu.Lock()
	defer auditMu.Unlock()
	if err := os.MkdirAll(state.Home(), 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(AuditPath()); err == nil && info.Size()+int64(len(b)) > auditMaxBytes {
		rotate()
	}
	f, err := os.OpenFile(AuditPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func rotated(n int) string { return state.Path(fmt.Sprintf("agent-audit.%d.jsonl", n)) }

func rotate() {
	_ = os.Remove(rotated(auditKeep - 1))
	for n := auditKeep - 2; n >= 1; n-- {
		_ = os.Rename(rotated(n), rotated(n+1))
	}
	_ = os.Rename(AuditPath(), rotated(1))
}

// ReadAudit returns the entries since a time, oldest first, across the rotated files.
func ReadAudit(since time.Time) ([]Entry, error) {
	files := []string{}
	for n := auditKeep - 1; n >= 1; n-- {
		files = append(files, rotated(n))
	}
	files = append(files, AuditPath())
	var out []Entry
	for _, f := range files {
		fh, err := os.Open(f)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			var e Entry
			if json.Unmarshal(sc.Bytes(), &e) == nil && !e.Time.Before(since) {
				out = append(out, e)
			}
		}
		fh.Close()
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })
	return out, nil
}

// Summary is one line for a person reading the log.
func (e Entry) Summary() string {
	var in []string
	for k, v := range e.Inputs {
		in = append(in, k+"="+v)
	}
	sort.Strings(in)
	s := fmt.Sprintf("%s  %-9s %-11s %s", e.Time.Local().Format("2006-01-02 15:04"), e.Action, e.Outcome, e.Tool)
	if len(in) > 0 {
		s += " " + strings.Join(in, " ")
	}
	return s + fmt.Sprintf("  (%s, consent: %s)", e.Client, e.Consent)
}
