package compositekey

// Ordering, database mapping and migration behavior require a GORM schema oracle.
type Membership struct {
    TenantID string `gorm:"column:tenant_id;primaryKey"`
    UserID   string `gorm:"column:user_id;primaryKey"`
    Role     string
}
