package embedded

type Address struct {
    City string
    ZIP  string
}

// Embedded fields and the prefix affect physical columns.
type Customer struct {
    ID      uint64
    Address Address `gorm:"embedded;embeddedPrefix:addr_"`
}
