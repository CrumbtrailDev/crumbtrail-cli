package crumbtrail

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// DB wraps database/sql without recording SQL literals, bindings or rows.
type DB struct {
	*sql.DB
	engine string
}

func WrapDB(db *sql.DB, engine string) (*DB, error) {
	if db == nil || (engine != "postgres" && engine != "mysql" && engine != "sqlite") {
		return nil, errors.New("crumbtrail requires a database and a postgres, mysql or sqlite engine")
	}
	return &DB{db, engine}, nil
}
func recordSQL(ctx context.Context, engine, query string, start time.Time, result sql.Result, err error) {
	defer func() { _ = recover() }()
	c, _ := ctx.Value(contextKey{}).(*captureContext)
	if c == nil {
		return
	}
	op := "other"
	if len(query) > 32768 {
		query = ""
	}
	fields := strings.Fields(query)
	if len(fields) > 0 {
		switch strings.ToLower(fields[0]) {
		case "select", "insert", "update", "delete":
			op = strings.ToLower(fields[0])
		}
	}
	var rows any
	if result != nil {
		if count, e := result.RowsAffected(); e == nil {
			rows = count
		}
	}
	c.mu.Lock()
	c.seq++
	seq := c.seq
	c.mu.Unlock()
	data := map[string]any{"engine": engine, "op": op, "table": nil, "shape": "[statement omitted]", "rowCount": rows, "rowEvidence": "not_captured", "seq": seq, "t": start.UnixMilli(), "durationMs": float64(time.Since(start).Microseconds()) / 1000}
	kind := "db.statement"
	if err != nil {
		kind = "db.error"
		data["category"] = "unknown"
		data["code"] = nil
		data["errorName"] = "database_error"
	}
	c.add(kind, data, start.UnixMilli())
}
func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	start := time.Now()
	result, err := d.DB.ExecContext(ctx, query, args...)
	recordSQL(ctx, d.engine, query, start, result, err)
	return result, err
}
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	start := time.Now()
	rows, err := d.DB.QueryContext(ctx, query, args...)
	recordSQL(ctx, d.engine, query, start, nil, err)
	return rows, err
}

// Row preserves QueryRow's deferred error semantics. Its capture completes at Scan.
type Row struct {
	row           *sql.Row
	ctx           context.Context
	engine, query string
	started       time.Time
}

func (r *Row) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	recordSQL(r.ctx, r.engine, r.query, r.started, nil, err)
	return err
}
func (r *Row) Err() error { return r.row.Err() }
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *Row {
	start := time.Now()
	row := d.DB.QueryRowContext(ctx, query, args...)
	return &Row{row, ctx, d.engine, query, start}
}

type Tx struct {
	*sql.Tx
	ctx    context.Context
	engine string
}

func (d *DB) BeginTx(ctx context.Context, options *sql.TxOptions) (*Tx, error) {
	tx, err := d.DB.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &Tx{tx, ctx, d.engine}, nil
}
func (t *Tx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	start := time.Now()
	result, err := t.Tx.ExecContext(ctx, query, args...)
	recordSQL(ctx, t.engine, query, start, result, err)
	return result, err
}
func (t *Tx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	start := time.Now()
	rows, err := t.Tx.QueryContext(ctx, query, args...)
	recordSQL(ctx, t.engine, query, start, nil, err)
	return rows, err
}
func (t *Tx) QueryRowContext(ctx context.Context, query string, args ...any) *Row {
	start := time.Now()
	row := t.Tx.QueryRowContext(ctx, query, args...)
	return &Row{row, ctx, t.engine, query, start}
}
func (t *Tx) Commit() error {
	start := time.Now()
	err := t.Tx.Commit()
	recordSQL(t.ctx, t.engine, "COMMIT", start, nil, err)
	return err
}
func (t *Tx) Rollback() error {
	start := time.Now()
	err := t.Tx.Rollback()
	recordSQL(t.ctx, t.engine, "ROLLBACK", start, nil, err)
	return err
}

type Stmt struct {
	*sql.Stmt
	engine, query string
}

func (d *DB) PrepareContext(ctx context.Context, query string) (*Stmt, error) {
	stmt, err := d.DB.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return &Stmt{stmt, d.engine, query}, nil
}
func (t *Tx) PrepareContext(ctx context.Context, query string) (*Stmt, error) {
	stmt, err := t.Tx.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return &Stmt{stmt, t.engine, query}, nil
}
func (s *Stmt) ExecContext(ctx context.Context, args ...any) (sql.Result, error) {
	start := time.Now()
	result, err := s.Stmt.ExecContext(ctx, args...)
	recordSQL(ctx, s.engine, s.query, start, result, err)
	return result, err
}
func (s *Stmt) QueryContext(ctx context.Context, args ...any) (*sql.Rows, error) {
	start := time.Now()
	rows, err := s.Stmt.QueryContext(ctx, args...)
	recordSQL(ctx, s.engine, s.query, start, nil, err)
	return rows, err
}
func (s *Stmt) QueryRowContext(ctx context.Context, args ...any) *Row {
	start := time.Now()
	row := s.Stmt.QueryRowContext(ctx, args...)
	return &Row{row, ctx, s.engine, s.query, start}
}
