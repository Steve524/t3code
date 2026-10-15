/// Splits `input` on commas and trims each field.
pub fn fields(input: &str) -> Vec<&str> {
    input.split(',').map(str::trim).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn trims_fields() {
        assert_eq!(super::fields(" a, b "), vec!["a", "b"]);
    }
}
