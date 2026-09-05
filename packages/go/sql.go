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

// sqlSpan holds what is known when a statement is issued. Both the sequence and the event
// timestamp are taken here rather than at completion: stamping either at completion sorts a
// slow query after faster ones issued after it, and leaves seq contradicting t.
type sqlSpan struct {
	c      *captureContext
	engine string
	seq    int
	at     int64
	start  time.Time
}

func beginSQL(ctx context.Context, engine string) sqlSpan {
	span := sqlSpan{engine: engine, start: time.Now()}
	defer func() { _ = recover() }()
	c, _ := ctx.Value(contextKey{}).(*captureContext)
	if c == nil {
		return span
	}
	span.c = c
	span.seq = c.nextSequence()
	span.at = span.start.UnixMilli()
	return span
}

func (s sqlSpan) finish(query string, result sql.Result, err error) {
	defer func() { _ = recover() }()
	if s.c == nil {
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
	data := map[string]any{"engine": s.engine, "op": op, "table": nil, "shape": "[statement omitted]",
		"rowCount": rows, "rowEvidence": "not_captured", "seq": s.seq, "t": s.at,
		"durationMs": float64(time.Since(s.start).Microseconds()) / 1000}
	kind := "db.statement"
	if err != nil {
		kind = "db.error"
		data["category"] = "unknown"
		data["code"] = nil
		data["errorName"] = "database_error"
	}
	s.c.add(kind, data, s.at)
}

func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	span := beginSQL(ctx, d.engine)
	result, err := d.DB.ExecContext(ctx, query, args...)
	span.finish(query, result, err)
	return result, err
}
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	span := beginSQL(ctx, d.engine)
	rows, err := d.DB.QueryContext(ctx, query, args...)
	span.finish(query, nil, err)
	return rows, err
}

// Row preserves QueryRow's deferred error semantics. Its capture completes at Scan.
type Row struct {
	row   *sql.Row
	span  sqlSpan
	query string
}

func (r *Row) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	r.span.finish(r.query, nil, err)
	return err
}
func (r *Row) Err() error { return r.row.Err() }
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *Row {
	span := beginSQL(ctx, d.engine)
	row := d.DB.QueryRowContext(ctx, query, args...)
	return &Row{row, span, query}
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
	span := beginSQL(ctx, t.engine)
	result, err := t.Tx.ExecContext(ctx, query, args...)
	span.finish(query, result, err)
	return result, err
}
func (t *Tx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	span := beginSQL(ctx, t.engine)
	rows, err := t.Tx.QueryContext(ctx, query, args...)
	span.finish(query, nil, err)
	return rows, err
}
func (t *Tx) QueryRowContext(ctx context.Context, query string, args ...any) *Row {
	span := beginSQL(ctx, t.engine)
	row := t.Tx.QueryRowContext(ctx, query, args...)
	return &Row{row, span, query}
}
func (t *Tx) Commit() error {
	span := beginSQL(t.ctx, t.engine)
	err := t.Tx.Commit()
	span.finish("COMMIT", nil, err)
	return err
}
func (t *Tx) Rollback() error {
	span := beginSQL(t.ctx, t.engine)
	err := t.Tx.Rollback()
	span.finish("ROLLBACK", nil, err)
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
	span := beginSQL(ctx, s.engine)
	result, err := s.Stmt.ExecContext(ctx, args...)
	span.finish(s.query, result, err)
	return result, err
}
func (s *Stmt) QueryContext(ctx context.Context, args ...any) (*sql.Rows, error) {
	span := beginSQL(ctx, s.engine)
	rows, err := s.Stmt.QueryContext(ctx, args...)
	span.finish(s.query, nil, err)
	return rows, err
}
func (s *Stmt) QueryRowContext(ctx context.Context, args ...any) *Row {
	span := beginSQL(ctx, s.engine)
	row := s.Stmt.QueryRowContext(ctx, args...)
	return &Row{row, span, s.query}
}
