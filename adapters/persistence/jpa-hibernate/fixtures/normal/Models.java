package example.scope.normal;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.util.UUID;

// Authored planning fixture: explicit names are source expectations, not runtime evidence.
@Entity
@Table(name = "accounts", schema = "billing")
class Account {
    @Id
    @Column(name = "account_id")
    UUID id;
}

@Entity
@Table(name = "invoices", schema = "billing")
class Invoice {
    @Id
    @Column(name = "invoice_id")
    UUID id;

    @ManyToOne
    @JoinColumn(name = "account_id", referencedColumnName = "account_id")
    Account account;
}
