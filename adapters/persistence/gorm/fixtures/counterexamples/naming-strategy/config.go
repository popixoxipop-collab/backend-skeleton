package namingstrategy

import (
    "gorm.io/gorm"
    "gorm.io/gorm/schema"
)

// A source-only model cannot fix physical names without this runtime configuration.
func config() *gorm.Config {
    return &gorm.Config{NamingStrategy: schema.NamingStrategy{
        TablePrefix: "tenant_",
        SingularTable: true,
    }}
}

type LedgerEntry struct {
    ID uint64
}
