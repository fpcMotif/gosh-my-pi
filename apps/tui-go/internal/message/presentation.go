package message

// ToolPresentationType identifies a semantic tool presentation variant.
type ToolPresentationType string

const (
	ToolPresentationTypeStatus ToolPresentationType = "status"
	ToolPresentationTypeBlock  ToolPresentationType = "block"
	ToolPresentationTypeCode   ToolPresentationType = "code"
)

// ToolPresentationIcon is a semantic status icon hint.
type ToolPresentationIcon string

const (
	ToolPresentationIconSuccess ToolPresentationIcon = "success"
	ToolPresentationIconError   ToolPresentationIcon = "error"
	ToolPresentationIconWarning ToolPresentationIcon = "warning"
	ToolPresentationIconInfo    ToolPresentationIcon = "info"
	ToolPresentationIconPending ToolPresentationIcon = "pending"
	ToolPresentationIconRunning ToolPresentationIcon = "running"
	ToolPresentationIconAborted ToolPresentationIcon = "aborted"
)

// ToolPresentationState is a block state hint.
type ToolPresentationState string

const (
	ToolPresentationStatePending ToolPresentationState = "pending"
	ToolPresentationStateRunning ToolPresentationState = "running"
	ToolPresentationStateSuccess ToolPresentationState = "success"
	ToolPresentationStateError   ToolPresentationState = "error"
	ToolPresentationStateWarning ToolPresentationState = "warning"
)

// ToolPresentationCodeStatus is a code cell state hint.
type ToolPresentationCodeStatus string

const (
	ToolPresentationCodeStatusPending  ToolPresentationCodeStatus = "pending"
	ToolPresentationCodeStatusRunning  ToolPresentationCodeStatus = "running"
	ToolPresentationCodeStatusWarning  ToolPresentationCodeStatus = "warning"
	ToolPresentationCodeStatusComplete ToolPresentationCodeStatus = "complete"
	ToolPresentationCodeStatusError    ToolPresentationCodeStatus = "error"
)

// ToolPresentation is frontend-neutral tool display data.
type ToolPresentation struct {
	Type     ToolPresentationType      `json:"type"`
	Status   *ToolPresentationStatus   `json:"status,omitempty"`
	State    ToolPresentationState     `json:"state,omitempty"`
	Sections []ToolPresentationSection `json:"sections,omitempty"`
	ApplyBg  bool                      `json:"applyBg,omitempty"`
	Code     *ToolPresentationCode     `json:"code,omitempty"`
}

// ToolPresentationStatus describes a compact tool status line.
type ToolPresentationStatus struct {
	Icon         ToolPresentationIcon `json:"icon,omitempty"`
	SpinnerFrame *int                 `json:"spinnerFrame,omitempty"`
	Title        string               `json:"title"`
	TitleColor   string               `json:"titleColor,omitempty"`
	Description  string               `json:"description,omitempty"`
	Meta         []string             `json:"meta,omitempty"`
}

// ToolPresentationSection is an ordered labeled block of text.
type ToolPresentationSection struct {
	Label string   `json:"label,omitempty"`
	Lines []string `json:"lines"`
}

// ToolPresentationCode describes code and optional output.
type ToolPresentationCode struct {
	Code           string                     `json:"code"`
	Language       string                     `json:"language,omitempty"`
	Title          string                     `json:"title,omitempty"`
	Status         ToolPresentationCodeStatus `json:"status,omitempty"`
	SpinnerFrame   *int                       `json:"spinnerFrame,omitempty"`
	Output         string                     `json:"output,omitempty"`
	OutputMaxLines *int                       `json:"outputMaxLines,omitempty"`
	CodeMaxLines   *int                       `json:"codeMaxLines,omitempty"`
	Expanded       bool                       `json:"expanded,omitempty"`
}

// Usable reports whether the known variant carries its required data.
func (p *ToolPresentation) Usable() bool {
	if p == nil {
		return false
	}
	switch p.Type {
	case ToolPresentationTypeStatus:
		return p.Status != nil && p.Status.Title != ""
	case ToolPresentationTypeBlock:
		if p.Sections == nil || p.Status != nil && p.Status.Title == "" {
			return false
		}
		for _, section := range p.Sections {
			if section.Lines == nil {
				return false
			}
		}
		return true
	case ToolPresentationTypeCode:
		return p.Code != nil
	default:
		return false
	}
}
