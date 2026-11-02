using System.Collections.Generic;
using Microsoft.EntityFrameworkCore;

namespace T00.EfCorePlan.Normal;

// Authored planning fixture; no C# build or EF model/database oracle has run.
public sealed class Account
{
    public long AccountId { get; set; }
    public string Name { get; set; } = "";
    public List<Invoice> Invoices { get; set; } = new();
}

public sealed class Invoice
{
    public long InvoiceId { get; set; }
    public long AccountId { get; set; }
    public Account Account { get; set; } = null!;
}

public sealed class BillingContext : DbContext
{
    public DbSet<Account> Accounts => Set<Account>();
    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Account>(entity =>
        {
            entity.ToTable("accounts", "billing");
            entity.HasKey(account => account.AccountId);
            entity.Property(account => account.AccountId).HasColumnName("account_id");
            entity.Property(account => account.Name).HasColumnName("display_name");
        });
        modelBuilder.Entity<Invoice>(entity =>
        {
            entity.ToTable("invoices", "billing");
            entity.HasKey(invoice => invoice.InvoiceId);
            entity.Property(invoice => invoice.InvoiceId).HasColumnName("invoice_id");
            entity.Property(invoice => invoice.AccountId).HasColumnName("account_id");
            entity.HasOne(invoice => invoice.Account)
                .WithMany(account => account.Invoices)
                .HasForeignKey(invoice => invoice.AccountId)
                .HasPrincipalKey(account => account.AccountId);
        });
    }
}
