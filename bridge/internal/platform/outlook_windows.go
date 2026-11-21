//go:build windows

package platform

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"

	"github.com/t128n/torbit/bridge/internal/core"
)

const (
	olFolderInbox = 6
	olMail        = 43
	propTransport = "http://schemas.microsoft.com/mapi/proptag/0x007D001F"
	propContentID = "http://schemas.microsoft.com/mapi/proptag/0x3712001F"
	propMimeTag   = "http://schemas.microsoft.com/mapi/proptag/0x370E001F"
)

// outlook drives classic desktop Outlook through COM. COM objects belong to the
// thread that made them, so every call runs on one dedicated, locked OS thread.
type outlook struct {
	calls chan func()
	app   *ole.IDispatch
}

func newOutlook() (core.Adapter, error) {
	o := &outlook{calls: make(chan func())}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
			ready <- err
			return
		}
		defer ole.CoUninitialize()
		ready <- nil
		for f := range o.calls {
			f()
		}
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return o, nil
}

func (o *outlook) do(f func() error) error {
	done := make(chan error, 1)
	o.calls <- func() { done <- f() }
	return <-done
}

func (o *outlook) Close() error {
	_ = o.do(func() error {
		if o.app != nil {
			o.app.Release()
			o.app = nil
		}
		return nil
	})
	close(o.calls)
	return nil
}

// ExplainOutlookError turns a COM failure into text that says what to do.
func ExplainOutlookError(err error) string {
	var oe *ole.OleError
	for e := err; e != nil; e = errors.Unwrap(e) {
		if x, ok := e.(*ole.OleError); ok {
			oe = x
			break
		}
	}
	if oe != nil {
		switch uint32(oe.Code()) {
		case 0x80040154: // REGDB_E_CLASSNOTREG
			return "Outlook (classic desktop version) is not installed. The bridge needs classic Outlook; new Outlook is not supported."
		case 0x80070005, 0x80080005, 0x80004005: // access denied, server execution failed, unspecified
			return "Windows or your administrator blocked the bridge from using Outlook. Ask your IT team to allow torbit-bridge to use Outlook automation, make sure Outlook and the bridge run as the same non-elevated user, then try again."
		}
	}
	return "The bridge could not talk to Outlook. Make sure classic Outlook is installed and signed in, then try again."
}

func (o *outlook) connect() error {
	if o.app != nil {
		return nil
	}
	unk, err := oleutil.CreateObject("Outlook.Application")
	if err != nil {
		return err
	}
	defer unk.Release()
	app, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return err
	}
	o.app = app
	return nil
}

func str(v *ole.VARIANT, err error) string {
	if err != nil || v == nil {
		return ""
	}
	defer v.Clear()
	if s, ok := v.Value().(string); ok {
		return s
	}
	return ""
}

func num(v *ole.VARIANT, err error) int64 {
	if err != nil || v == nil {
		return 0
	}
	defer v.Clear()
	switch x := v.Value().(type) {
	case int64:
		return x
	case int32:
		return int64(x)
	case int:
		return int64(x)
	}
	return 0
}

func disp(v *ole.VARIANT, err error) (*ole.IDispatch, error) {
	if err != nil {
		return nil, err
	}
	d := v.ToIDispatch()
	if d == nil {
		return nil, errors.New("unexpected COM result")
	}
	return d, nil
}

func (o *outlook) Inbox(since time.Time) ([]core.Item, func(), error) {
	var items []core.Item
	var held []*ole.IDispatch
	release := func() {
		_ = o.do(func() error {
			for i := len(held) - 1; i >= 0; i-- {
				held[i].Release()
			}
			held = nil
			return nil
		})
	}
	err := o.do(func() error {
		if err := o.connect(); err != nil {
			return err
		}
		keep := func(d *ole.IDispatch, err error) (*ole.IDispatch, error) {
			if err == nil {
				held = append(held, d)
			}
			return d, err
		}
		ns, err := keep(disp(oleutil.CallMethod(o.app, "GetNamespace", "MAPI")))
		if err != nil {
			return err
		}
		inbox, err := keep(disp(oleutil.CallMethod(ns, "GetDefaultFolder", olFolderInbox)))
		if err != nil {
			return err
		}
		all, err := keep(disp(oleutil.GetProperty(inbox, "Items")))
		if err != nil {
			return err
		}
		// Outlook filters on local time at minute resolution; the sweep re-checks exactly.
		filter := "[ReceivedTime] >= '" + since.Local().Format("1/2/2006 3:04 PM") + "'"
		list, err := keep(disp(oleutil.CallMethod(all, "Restrict", filter)))
		if err != nil {
			return err
		}
		if _, err := oleutil.CallMethod(list, "Sort", "[ReceivedTime]"); err != nil {
			return err
		}
		count := int(num(oleutil.GetProperty(list, "Count")))
		for i := 1; i <= count; i++ {
			mi, err := disp(oleutil.CallMethod(list, "Item", i))
			if err != nil {
				continue
			}
			held = append(held, mi)
			if num(oleutil.GetProperty(mi, "Class")) != olMail {
				continue
			}
			items = append(items, o.readItem(mi))
		}
		return nil
	})
	if err != nil {
		release()
		_ = o.do(func() error { // Outlook may have been closed: reconnect next time
			if o.app != nil {
				o.app.Release()
				o.app = nil
			}
			return nil
		})
		return nil, func() {}, errors.New(ExplainOutlookError(err))
	}
	return items, release, nil
}

func (o *outlook) readItem(mi *ole.IDispatch) core.Item {
	it := core.Item{
		EntryID:     str(oleutil.GetProperty(mi, "EntryID")),
		Subject:     str(oleutil.GetProperty(mi, "Subject")),
		SenderName:  str(oleutil.GetProperty(mi, "SenderName")),
		SenderEmail: str(oleutil.GetProperty(mi, "SenderEmailAddress")),
		To:          str(oleutil.GetProperty(mi, "To")),
		Body:        str(oleutil.GetProperty(mi, "Body")),
		HTMLBody:    str(oleutil.GetProperty(mi, "HTMLBody")),
		Size:        num(oleutil.GetProperty(mi, "Size")),
	}
	if v, err := oleutil.GetProperty(mi, "ReceivedTime"); err == nil {
		if t, ok := v.Value().(time.Time); ok {
			// VT_DATE is local wall-clock time; go-ole labels it UTC.
			it.ReceivedTime = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, time.Local).UTC()
		}
		v.Clear()
	}
	if pa, err := disp(oleutil.GetProperty(mi, "PropertyAccessor")); err == nil {
		it.TransportHeaders = str(oleutil.CallMethod(pa, "GetProperty", propTransport))
		pa.Release()
	}
	// Attachments are read only when the item is sent, and not at all for an
	// item whose Size is over the limit.
	it.LoadAttachments = func() ([]core.Attachment, error) {
		var out []core.Attachment
		err := o.do(func() error {
			var e error
			out, e = readAttachments(mi)
			return e
		})
		return out, err
	}
	return it
}

func readAttachments(mi *ole.IDispatch) ([]core.Attachment, error) {
	atts, err := disp(oleutil.GetProperty(mi, "Attachments"))
	if err != nil {
		return nil, err
	}
	defer atts.Release()
	count := int(num(oleutil.GetProperty(atts, "Count")))
	var out []core.Attachment
	for i := 1; i <= count; i++ {
		a, err := disp(oleutil.CallMethod(atts, "Item", i))
		if err != nil {
			return nil, err
		}
		att, err := readAttachment(a)
		a.Release()
		if err != nil {
			return nil, err
		}
		out = append(out, att)
	}
	return out, nil
}

func readAttachment(a *ole.IDispatch) (core.Attachment, error) {
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("torbit-%d-%d", os.Getpid(), time.Now().UnixNano()))
	defer os.Remove(tmp)
	if _, err := oleutil.CallMethod(a, "SaveAsFile", tmp); err != nil {
		return core.Attachment{}, err
	}
	att := core.Attachment{FileName: str(oleutil.GetProperty(a, "FileName"))}
	if pa, err := disp(oleutil.GetProperty(a, "PropertyAccessor")); err == nil {
		att.ContentID = str(oleutil.CallMethod(pa, "GetProperty", propContentID))
		att.MimeType = str(oleutil.CallMethod(pa, "GetProperty", propMimeTag))
		pa.Release()
	}
	att.IsInline = att.ContentID != ""
	b, err := os.ReadFile(tmp)
	if err != nil {
		return att, err
	}
	att.Bytes = b
	return att, nil
}
