package normal

// Authored planning fixture; neither T08 source facts nor a GORM runtime oracle ran.
type Account struct {
    AccountID uint64 `gorm:"column:account_id;primaryKey"`
    Name      string `gorm:"column:display_name"`
}

func (Account) TableName() string { return "accounts" }

type Invoice struct {
    InvoiceID uint64  `gorm:"column:invoice_id;primaryKey"`
    AccountID uint64  `gorm:"column:account_id"`
    Account   Account `gorm:"foreignKey:AccountID;references:AccountID"`
}

func (Invoice) TableName() string { return "invoices" }
