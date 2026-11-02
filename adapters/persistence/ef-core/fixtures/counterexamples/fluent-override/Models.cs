using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace T00.EfCorePlan.FluentOverride;

[Table("legacy_accounts")]
public sealed class Account
{
    public long Id { get; set; }
}

// The Fluent mapping overrides the annotation; class/annotation text is not the physical oracle.
public sealed class OverrideContext : DbContext
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Account>().ToTable("current_accounts");
    }
}
